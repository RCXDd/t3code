import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  issueSpeechToTextUploadUrl,
  layerSpeechToTextRoute,
  SPEECH_TO_TEXT_ROUTE_PREFIX,
  validateSpeechToTextUploadToken,
} from "./SpeechToTextRoute.ts";

const layerWith = (speechToText: Parameters<typeof ServerSettingsService.layerTest>[0]) =>
  Layer.mergeAll(ServerSecretStore.layer, ServerSettingsService.layerTest(speechToText)).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-speech-to-text-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const configured = layerWith({
  speechToText: { provider: "groq", providers: { groq: { apiKey: "gsk" } } },
});

const input = { mimeType: "audio/webm", sizeBytes: 2048 } as const;

describe("SpeechToTextRoute upload URLs", () => {
  it.effect("signs the recording's type and size", () =>
    Effect.gen(function* () {
      const issued = yield* issueSpeechToTextUploadUrl(input);
      const token = issued.relativeUrl.slice(`${SPEECH_TO_TEXT_ROUTE_PREFIX}/`.length);
      expect(yield* validateSpeechToTextUploadToken(token)).toMatchObject({
        kind: "speech-to-text-upload",
        mimeType: "audio/webm",
        sizeBytes: 2048,
      });

      const [payload, signature] = token.split(".");
      expect(yield* validateSpeechToTextUploadToken(`${payload}x.${signature}`)).toBeNull();
      expect(yield* validateSpeechToTextUploadToken(`${token}.extra`)).toBeNull();
    }).pipe(Effect.provide(configured)),
  );

  it.effect("refuses to mint a URL until a provider is set up", () =>
    Effect.gen(function* () {
      const failure = yield* issueSpeechToTextUploadUrl(input).pipe(Effect.flip);
      expect(failure._tag).toBe("SpeechToTextUnavailableError");
      expect(failure.reason).toBe("not-configured");
    }).pipe(Effect.provide(layerWith({ speechToText: { provider: "openai", providers: {} } }))),
  );
});

describe("SpeechToTextRoute transcription", () => {
  it.effect("transcribes an upload through the configured service", () =>
    Effect.gen(function* () {
      const forwarded: Array<{ url: string; size: number }> = [];
      const provider = HttpClient.make((request) =>
        Effect.sync(() => {
          const file =
            request.body._tag === "FormData" ? (request.body.formData.get("file") as File) : null;
          forwarded.push({ url: request.url, size: file?.size ?? -1 });
          return HttpClientResponse.fromWeb(request, Response.json({ text: "Hallo Welt." }));
        }),
      );
      const issued = yield* issueSpeechToTextUploadUrl({ mimeType: "audio/webm", sizeBytes: 4 });
      const context = yield* Effect.context<
        ServerSecretStore.ServerSecretStore | ServerSettingsService
      >();
      const { handler, dispose } = HttpRouter.toWebHandler(
        layerSpeechToTextRoute.pipe(
          Layer.provideMerge(Layer.succeedContext(context)),
          Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, provider)),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const post = (body: Uint8Array) =>
        Effect.promise(() =>
          handler(
            new Request(`http://t3.test${issued.relativeUrl}`, {
              method: "POST",
              headers: { "content-type": "audio/webm" },
              body: body as Uint8Array<ArrayBuffer>,
            }),
          ),
        );

      const response = yield* post(new Uint8Array([1, 2, 3, 4]));
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({ text: "Hallo Welt." });
      expect(forwarded).toEqual([
        { url: "https://api.groq.com/openai/v1/audio/transcriptions", size: 4 },
      ]);

      // A body that does not match the signed size never reaches the service.
      const mismatched = yield* post(new Uint8Array([1, 2]));
      expect(mismatched.status).toBe(400);
      expect(forwarded).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(configured)),
  );
});

describe("SpeechToTextRoute cleanup", () => {
  it.effect("inserts the raw transcript and reports why cleanup failed", () =>
    Effect.gen(function* () {
      const provider = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ text: "äh hallo" }))),
      );
      const issued = yield* issueSpeechToTextUploadUrl({ mimeType: "audio/webm", sizeBytes: 1 });
      const context = yield* Effect.context<
        ServerSecretStore.ServerSecretStore | ServerSettingsService
      >();
      const { handler, dispose } = HttpRouter.toWebHandler(
        layerSpeechToTextRoute.pipe(
          Layer.provideMerge(Layer.succeedContext(context)),
          Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, provider)),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const response = yield* Effect.promise(() =>
        handler(
          new Request(`http://t3.test${issued.relativeUrl}`, {
            method: "POST",
            body: new Uint8Array([1]),
          }),
        ),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        text: "äh hallo",
        cleanupError: "Add the cleanup server URL and model in Settings → Speech to text.",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerWith({
          speechToText: {
            provider: "groq",
            providers: { groq: { apiKey: "gsk" } },
            cleanup: { mode: "openai-compatible" },
          },
        }),
      ),
    ),
  );
});
