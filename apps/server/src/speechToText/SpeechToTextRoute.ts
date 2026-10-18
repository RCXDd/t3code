// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import {
  isSpeechToTextConfigured,
  type ServerSettings,
  ThreadId,
  SPEECH_TO_TEXT_UPLOAD_URL_TTL_MS,
  type SpeechToTextCreateUploadUrlInput,
  SpeechToTextUnavailableError,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  cleanDictation,
  recentDictationConversation,
  SpeechToTextCleanupFailure,
} from "./SpeechToTextCleanup.ts";
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
  threadId: Schema.optionalKey(ThreadId),
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
      ...(input.threadId ? { threadId: input.threadId } : {}),
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

// Without a user-turn limit the window never widens to whole turns, which can hold megabytes of
// tool output. The limit applies per thread segment, so a fork reads it once per ancestor; fork
// chains are short, and the timeout below bounds the rest. Six chat messages are kept.
const CONTEXT_ROW_LIMIT = 16;
const CONTEXT_TIMEOUT = "5 seconds";

const readDictationConversation = Effect.fn("SpeechToText.readDictationConversation")(function* (
  threadId: ThreadId | null,
) {
  if (!threadId) return [];
  // The orchestrator, not ThreadManagementService, so context never triggers a legacy import.
  const orchestrator = yield* Effect.serviceOption(Orchestrator.OrchestratorV2);
  if (Option.isNone(orchestrator)) return [];
  return yield* orchestrator.value
    .getThreadSnapshotWindow(threadId, { rowLimit: CONTEXT_ROW_LIMIT })
    .pipe(
      // Visible items include a fork's inherited conversation.
      Effect.map((snapshot) => recentDictationConversation(snapshot.projection.visibleTurnItems)),
      Effect.timeout(CONTEXT_TIMEOUT),
      // Context only improves spelling; a missing or slow thread must not fail dictation.
      Effect.orElseSucceed(() => []),
    );
});

/** A failed cleanup still inserts the raw transcript, and reports why it was not cleaned. */
const cleanTranscript = Effect.fn("SpeechToText.cleanTranscript")(function* (
  settings: ServerSettings,
  transcript: string,
  threadId: ThreadId | null,
) {
  const cleanup = settings.speechToText.cleanup;
  const conversation =
    cleanup.useThreadContext && cleanup.mode === "openai-compatible"
      ? yield* readDictationConversation(threadId)
      : [];
  const textGeneration = yield* Effect.serviceOption(TextGeneration.TextGeneration);
  // An empty directory: the rewrite needs no checkout, and agent CLIs read their working tree.
  const fileSystem = yield* FileSystem.FileSystem;
  // Removal is best-effort: a directory that cannot be deleted must not cost the transcript.
  const cwd = yield* Effect.acquireRelease(
    fileSystem.makeTempDirectory({ prefix: "t3code-dictation-" }).pipe(Effect.option),
    (directory) =>
      Option.isSome(directory)
        ? fileSystem.remove(directory.value, { recursive: true }).pipe(Effect.ignoreCause)
        : Effect.void,
  ).pipe(Effect.map((directory) => Option.getOrElse(directory, () => NodeOS.tmpdir())));
  return yield* cleanDictation({
    settings: settings.speechToText,
    transcript,
    conversation,
    textGenerationModel: settings.textGenerationModelSelection,
    textGeneration: Option.getOrNull(textGeneration),
    cwd,
  }).pipe(
    Effect.map((text) => jsonResponse(200, { text })),
    Effect.catchTags({
      SpeechToTextCleanupFailure: (failure: SpeechToTextCleanupFailure) =>
        Effect.as(
          Effect.logWarning("Dictation cleanup failed; returning the raw transcript.", {
            message: failure.message,
          }),
          jsonResponse(200, { text: transcript, cleanupError: failure.message }),
        ),
    }),
  );
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
        Effect.flatMap((transcript) =>
          settings.value.speechToText.cleanup.mode === null
            ? Effect.succeed(jsonResponse(200, { text: transcript }))
            : cleanTranscript(settings.value, transcript, claims.threadId ?? null).pipe(
                Effect.scoped,
              ),
        ),
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
