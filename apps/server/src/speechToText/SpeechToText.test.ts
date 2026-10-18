import { describe, expect, it } from "@effect/vitest";
import { SpeechToTextSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  parseSpeechToTextResponse,
  resolveSpeechToTextRequest,
  SpeechToTextFailure,
  speechToTextFileName,
  transcribeSpeech,
} from "./SpeechToText.ts";

const settings = Schema.decodeUnknownSync(SpeechToTextSettings);

describe("resolveSpeechToTextRequest", () => {
  it("sends OpenAI-style providers to /audio/transcriptions with their defaults", () => {
    const request = resolveSpeechToTextRequest(
      settings({
        provider: "groq",
        language: "de",
        prompt: "T3 Code, Effect",
        providers: { groq: { apiKey: "gsk" } },
      }),
      "audio/webm;codecs=opus",
    );
    expect(request).toEqual({
      provider: "groq",
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      headers: { authorization: "Bearer gsk" },
      fields: [
        ["model", "whisper-large-v3-turbo"],
        ["response_format", "json"],
        ["language", "de"],
        ["prompt", "T3 Code, Effect"],
      ],
      fileName: "dictation.webm",
    });
  });

  it("uses each service's own endpoint, auth header and field names", () => {
    const elevenlabs = resolveSpeechToTextRequest(
      settings({
        provider: "elevenlabs",
        language: "en",
        providers: { elevenlabs: { apiKey: "xi" } },
      }),
      "audio/mp4",
    );
    expect(elevenlabs).toMatchObject({
      url: "https://api.elevenlabs.io/v1/speech-to-text",
      headers: { "xi-api-key": "xi" },
      fields: [
        ["model_id", "scribe_v2"],
        ["tag_audio_events", "false"],
        ["language_code", "en"],
      ],
      fileName: "dictation.m4a",
    });

    const xai = resolveSpeechToTextRequest(
      settings({ provider: "xai", prompt: "ignored", providers: { xai: { apiKey: "xk" } } }),
      "audio/webm",
    );
    expect(xai).toMatchObject({ url: "https://api.x.ai/v1/stt", fields: [["format", "true"]] });

    // Mistral ignores prompts; they must not be sent.
    const mistral = resolveSpeechToTextRequest(
      settings({
        provider: "mistral",
        prompt: "ignored",
        providers: { mistral: { apiKey: "mk" } },
      }),
      "audio/webm",
    );
    expect(mistral).toMatchObject({
      url: "https://api.mistral.ai/v1/audio/transcriptions",
      fields: [
        ["model", "voxtral-mini-latest"],
        ["response_format", "json"],
      ],
    });
  });

  it("lets a self-hosted server run without a key", () => {
    const request = resolveSpeechToTextRequest(
      settings({
        provider: "openai-compatible",
        providers: {
          "openai-compatible": {
            baseUrl: "http://127.0.0.1:8000/v1/",
            model: "Systran/faster-whisper-small",
          },
        },
      }),
      "audio/wav",
    );
    expect(request).toMatchObject({
      url: "http://127.0.0.1:8000/v1/audio/transcriptions",
      headers: {},
      fileName: "dictation.wav",
    });
  });

  it("explains what is missing", () => {
    const off = resolveSpeechToTextRequest(settings({}), "audio/webm");
    expect(off).toBeInstanceOf(SpeechToTextFailure);
    const missingKey = resolveSpeechToTextRequest(settings({ provider: "openai" }), "audio/webm");
    expect((missingKey as SpeechToTextFailure).message).toBe(
      "Add your OpenAI API key in Settings → Speech to text.",
    );
    const missingUrl = resolveSpeechToTextRequest(
      settings({ provider: "openai-compatible" }),
      "audio/webm",
    );
    expect((missingUrl as SpeechToTextFailure).message).toBe(
      "Add the server URL in Settings → Speech to text.",
    );
  });
});

describe("parseSpeechToTextResponse", () => {
  it("returns the trimmed transcript", () => {
    expect(parseSpeechToTextResponse("openai", 200, '{"text":" Hallo Welt "}')).toBe("Hallo Welt");
  });

  it("surfaces the provider's error message", () => {
    const failure = parseSpeechToTextResponse(
      "openai",
      401,
      '{"error":{"message":"Incorrect API key provided."}}',
    );
    expect((failure as SpeechToTextFailure).message).toBe(
      "OpenAI rejected the recording (HTTP 401): Incorrect API key provided.",
    );
    const elevenlabs = parseSpeechToTextResponse(
      "elevenlabs",
      422,
      '{"detail":{"message":"Unsupported audio."}}',
    );
    expect((elevenlabs as SpeechToTextFailure).message).toContain("Unsupported audio.");
  });

  it("rejects a success without text", () => {
    expect(parseSpeechToTextResponse("groq", 200, "{}")).toBeInstanceOf(SpeechToTextFailure);
  });
});

describe("speechToTextFileName", () => {
  it("matches the container so the service picks the right decoder", () => {
    expect(speechToTextFileName("audio/ogg;codecs=opus")).toBe("dictation.ogg");
    expect(speechToTextFileName("audio/x-m4a")).toBe("dictation.m4a");
    expect(speechToTextFileName("application/octet-stream")).toBe("dictation.webm");
  });
});

describe("transcribeSpeech", () => {
  it.effect("uploads the recording as multipart form data", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined; form: FormData }> = [];
      const http = HttpClient.make((request) =>
        Effect.promise(async () => {
          if (request.body._tag !== "FormData") throw new Error("expected multipart body");
          seen.push({
            url: request.url,
            auth: request.headers.authorization,
            form: request.body.formData,
          });
          return HttpClientResponse.fromWeb(request, Response.json({ text: "Hello there." }));
        }),
      );
      const text = yield* transcribeSpeech(
        settings({
          provider: "openai",
          providers: { openai: { apiKey: "sk", model: "whisper-1" } },
        }),
        { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/webm" },
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));

      expect(text).toBe("Hello there.");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(seen[0]!.auth).toBe("Bearer sk");
      expect(seen[0]!.form.get("model")).toBe("whisper-1");
      const file = seen[0]!.form.get("file") as File;
      expect(file.name).toBe("dictation.webm");
      expect(file.size).toBe(3);
    }),
  );

  it.effect("never repeats the configured key from a provider error", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              { error: { message: "Invalid API key: gsk-secret-123" } },
              { status: 401 },
            ),
          ),
        ),
      );
      const failure = yield* transcribeSpeech(
        settings({ provider: "groq", providers: { groq: { apiKey: "gsk-secret-123" } } }),
        { bytes: new Uint8Array([1]), mimeType: "audio/webm" },
      ).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip);
      expect(failure.message).not.toContain("gsk-secret-123");
      expect(failure.message).toBe(
        "Groq rejected the recording (HTTP 401): Invalid API key: [redacted]",
      );
    }),
  );

  it.effect("fails with the provider's message instead of an empty transcript", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: { message: "quota exceeded" } }, { status: 429 }),
          ),
        ),
      );
      const failure = yield* transcribeSpeech(
        settings({ provider: "groq", providers: { groq: { apiKey: "gsk" } } }),
        { bytes: new Uint8Array([1]), mimeType: "audio/webm" },
      ).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip);
      expect(failure.status).toBe(502);
      expect(failure.message).toBe("Groq rejected the recording (HTTP 429): quota exceeded");
    }),
  );
});
