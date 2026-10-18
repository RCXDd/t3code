import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  SpeechToTextSettings,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  cleanDictation,
  recentDictationConversation,
  stripReasoning,
} from "./SpeechToTextCleanup.ts";

const settings = Schema.decodeUnknownSync(SpeechToTextSettings);
const noRequests = HttpClient.make(() => Effect.die("no request expected"));
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const baseInput = {
  transcript:
    "  ähm also kannst du bitte die die tests für den speech to text dings laufen lassen ",
  conversation: [{ role: "assistant" as const, text: "I added `SpeechToTextRoute.test.ts`." }],
  textGenerationModel: modelSelection,
  textGeneration: null,
  cwd: "/tmp",
};

describe("recentDictationConversation", () => {
  it("keeps the last chat messages and drops tool output", () => {
    const message = (type: "user_message" | "assistant_message" | "reasoning", text: string) =>
      ({ item: { type, text } }) as unknown as { item: OrchestrationV2TurnItem };
    const items = [
      message("user_message", "first"),
      message("reasoning", "thinking"),
      ...Array.from({ length: 6 }, (_, index) => message("assistant_message", `reply ${index}`)),
      message("user_message", "  "),
    ];
    expect(recentDictationConversation(items)).toEqual(
      Array.from({ length: 6 }, (_, index) => ({ role: "assistant", text: `reply ${index}` })),
    );
  });
});

describe("stripReasoning", () => {
  it("removes thinking blocks that local reasoning models emit", () => {
    expect(stripReasoning("<think>\nplan\n</think>\nRun the tests.")).toBe("Run the tests.");
  });
});

describe("cleanDictation", () => {
  it.effect("returns the trimmed transcript when cleanup is off", () =>
    Effect.gen(function* () {
      const text = yield* cleanDictation({ ...baseInput, settings: settings({}) }).pipe(
        Effect.provideService(HttpClient.HttpClient, noRequests),
      );
      expect(text).toBe(baseInput.transcript.trim());
    }),
  );

  it.effect("asks a chat completions model with vocabulary and conversation", () =>
    Effect.gen(function* () {
      const bodies: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const body =
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : null;
          bodies.push({ url: request.url, auth: request.headers.authorization, body });
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              choices: [
                {
                  message: { content: "<think>ok</think>Kannst du bitte die Tests laufen lassen?" },
                },
              ],
            }),
          );
        }),
      );
      const text = yield* cleanDictation({
        ...baseInput,
        settings: settings({
          language: "de",
          prompt: "T3 Code, Parakeet",
          cleanup: {
            mode: "openai-compatible",
            baseUrl: "http://127.0.0.1:11434/v1/",
            model: "qwen3:4b",
          },
        }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));

      expect(text).toBe("Kannst du bitte die Tests laufen lassen?");
      expect(bodies[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
      expect(bodies[0]!.auth).toBeUndefined();
      const request = bodies[0]!.body as {
        model: string;
        messages: Array<{ content: string }>;
      };
      expect(request.model).toBe("qwen3:4b");
      const prompt = request.messages[0]!.content;
      expect(prompt).toContain("Vocabulary:\nT3 Code, Parakeet");
      expect(prompt).toContain("Agent: I added `SpeechToTextRoute.test.ts`.");
      expect(prompt).toContain("Language: de");
      expect(prompt).toContain(baseInput.transcript.trim());
      expect(prompt).toContain("Reply with only the cleaned message.");
      expect(prompt).not.toContain("JSON");
    }),
  );

  it.effect("never sends thread context to an agent CLI with tools", () =>
    Effect.gen(function* () {
      const calls: Array<
        Parameters<NonNullable<TextGeneration.TextGeneration["Service"]["cleanDictation"]>>[0]
      > = [];
      const textGeneration = {
        cleanDictation: (input: (typeof calls)[number]) =>
          Effect.sync(() => {
            calls.push(input);
            return { text: "Kannst du bitte die Tests laufen lassen?" };
          }),
      } as unknown as TextGeneration.TextGeneration["Service"];
      const text = yield* cleanDictation({
        ...baseInput,
        textGeneration,
        settings: settings({ cleanup: { mode: "text-generation", useThreadContext: true } }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, noRequests));
      expect(text).toBe("Kannst du bitte die Tests laufen lassen?");
      expect(calls[0]!.modelSelection).toEqual(modelSelection);
      expect(calls[0]!.conversation).toEqual([]);
    }),
  );

  it.effect("refuses to rewrite a transcript longer than the prompt can hold", () =>
    Effect.gen(function* () {
      const failure = yield* cleanDictation({
        ...baseInput,
        transcript: `${"word ".repeat(4_001)}END`,
        settings: settings({
          cleanup: { mode: "openai-compatible", baseUrl: "http://x/v1", model: "m" },
        }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, noRequests), Effect.flip);
      expect(failure.message).toBe(
        "The recording is too long to clean up, so it was inserted as transcribed.",
      );
    }),
  );

  it.effect("keeps the transcript when the model answers with nothing", () =>
    Effect.gen(function* () {
      const textGeneration = {
        cleanDictation: () => Effect.succeed({ text: "" }),
      } as unknown as TextGeneration.TextGeneration["Service"];
      const text = yield* cleanDictation({
        ...baseInput,
        textGeneration,
        settings: settings({ cleanup: { mode: "text-generation" } }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, noRequests));
      expect(text).toBe(baseInput.transcript.trim());
    }),
  );

  it.effect("fails with a reason the route can report", () =>
    Effect.gen(function* () {
      const failure = yield* cleanDictation({
        ...baseInput,
        settings: settings({ cleanup: { mode: "openai-compatible" } }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, noRequests), Effect.flip);
      expect(failure.message).toBe(
        "Add the cleanup server URL and model in Settings → Speech to text.",
      );
    }),
  );
});
