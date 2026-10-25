import {
  isSpeechToTextConfigured,
  SPEECH_TO_TEXT_UPLOAD_URL_TTL_MS,
  type SpeechToTextCreateUploadUrlInput,
  SpeechToTextUnavailableError,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SpeechToTextFailure, transcribeSpeech } from "./SpeechToText.ts";

export const SPEECH_TO_TEXT_ROUTE_PREFIX = "/api/speech-to-text/transcriptions";

const SIGNING_SECRET_NAME = "speech-to-text-upload-signing-key";

// The URL is the credential, like attachment uploads, so every client and connection mode can
// POST the recording without building auth headers. The claims pin the size and type.
const UploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("speech-to-text-upload"),
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
type UploadClaims = typeof UploadClaims.Type;

const uploadClaimsJson = Schema.fromJsonString(UploadClaims);
const decodeUploadClaims = Schema.decodeUnknownOption(uploadClaimsJson);
const encodeUploadClaims = Schema.encodeSync(uploadClaimsJson);

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

export const issueSpeechToTextUploadUrl = Effect.fn("SpeechToText.issueUploadUrl")(function* (
  input: SpeechToTextCreateUploadUrlInput,
) {
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
  if (!settings || !isSpeechToTextConfigured(settings.speechToText)) {
    return yield* new SpeechToTextUnavailableError({ reason: "not-configured" });
  }
  const secret = yield* loadSigningSecret.pipe(
    Effect.mapError(() => new SpeechToTextUnavailableError({ reason: "signing-key" })),
  );
  const expiresAt = (yield* Clock.currentTimeMillis) + SPEECH_TO_TEXT_UPLOAD_URL_TTL_MS;
  const encodedPayload = base64UrlEncode(
    encodeUploadClaims({
      version: 1,
      kind: "speech-to-text-upload",
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      expiresAt,
    }),
  );
  return {
    relativeUrl: `${SPEECH_TO_TEXT_ROUTE_PREFIX}/${encodedPayload}.${signPayload(encodedPayload, secret)}`,
    expiresAt,
  };
});

export const validateSpeechToTextUploadToken = Effect.fn("SpeechToText.validateUploadToken")(
  function* (token: string) {
    const [encodedPayload, signature, unexpectedSegment] = token.split(".");
    if (!encodedPayload || !signature || unexpectedSegment) return null;
    const secret = yield* loadSigningSecret.pipe(Effect.orElseSucceed(() => null));
    if (!secret || !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) {
      return null;
    }
    let claims: UploadClaims | null;
    try {
      claims = Option.getOrNull(decodeUploadClaims(base64UrlDecodeUtf8(encodedPayload)));
    } catch {
      claims = null;
    }
    if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
    return claims;
  },
);

const jsonResponse = (status: number, body: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });

export const layerSpeechToTextRoute = HttpRouter.add(
  "POST",
  `${SPEECH_TO_TEXT_ROUTE_PREFIX}/*`,
  // The token in the path is the credential, so this request never reaches the access log.
  HttpMiddleware.withLoggerDisabled(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) return jsonResponse(400, { error: "Bad request." });

      const token = url.value.pathname.slice(`${SPEECH_TO_TEXT_ROUTE_PREFIX}/`.length);
      const claims = token ? yield* validateSpeechToTextUploadToken(token) : null;
      if (!claims) {
        return jsonResponse(404, { error: "This upload link expired. Record again." });
      }
      const contentLength = request.headers["content-length"];
      if (contentLength !== undefined && Number(contentLength) !== claims.sizeBytes) {
        return jsonResponse(400, { error: "Content-Length must match the upload size." });
      }
      // Chunked requests carry no content-length, so the reader itself is capped.
      const body = yield* request.arrayBuffer.pipe(
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(claims.sizeBytes)),
        Effect.option,
      );
      if (Option.isNone(body) || body.value.byteLength !== claims.sizeBytes) {
        return jsonResponse(400, { error: "The recording did not match its declared size." });
      }

      const settingsService = yield* ServerSettingsService;
      const settings = yield* settingsService.getSettings.pipe(Effect.option);
      if (Option.isNone(settings)) {
        return jsonResponse(500, { error: "Could not read the speech-to-text settings." });
      }
      return yield* transcribeSpeech(settings.value.speechToText, {
        bytes: body.value,
        mimeType: claims.mimeType,
      }).pipe(
        Effect.map((text) => jsonResponse(200, { text })),
        Effect.catchTags({
          SpeechToTextFailure: (failure: SpeechToTextFailure) =>
            Effect.as(
              Effect.logWarning("Speech-to-text transcription failed.", {
                status: failure.status,
                message: failure.message,
              }),
              jsonResponse(failure.status, { error: failure.message }),
            ),
        }),
      );
    }),
  ),
);
