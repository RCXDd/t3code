import type {
  ModelSelection,
  OrchestrationV2ThreadTranscript,
  SpeechToTextSettings,
} from "@t3tools/contracts";
import { buildDictationCleanupPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const CLEANUP_TIMEOUT = "60 seconds";
const CONVERSATION_MESSAGES = 6;
const CONVERSATION_MESSAGE_CHARS = 1_500;

export class SpeechToTextCleanupFailure extends Data.TaggedError("SpeechToTextCleanupFailure")<{
  readonly message: string;
}> {}

export type DictationConversation = ReadonlyArray<{
  readonly role: "user" | "assistant";
  readonly text: string;
}>;

/** The last few chat messages; tool calls and reasoning carry no spelling the user dictates. */
export function recentDictationConversation(
  transcript: OrchestrationV2ThreadTranscript,
): DictationConversation {
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const { item } of transcript.items) {
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    const text = item.text.trim();
    if (!text) continue;
    messages.push({
      role: item.type === "user_message" ? "user" : "assistant",
      text:
        text.length > CONVERSATION_MESSAGE_CHARS
          ? `${text.slice(0, CONVERSATION_MESSAGE_CHARS)}…`
          : text,
    });
  }
  return messages.slice(-CONVERSATION_MESSAGES);
}

/** Local reasoning models (Qwen, DeepSeek) wrap their thinking in tags before the answer. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function readChatCompletionText(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
  return typeof message?.content === "string" ? message.content : null;
}

const cleanWithChatCompletions = Effect.fn("SpeechToText.cleanWithChatCompletions")(function* (
  cleanup: SpeechToTextSettings["cleanup"],
  prompt: string,
) {
  const baseUrl = cleanup.baseUrl.replace(/\/+$/, "");
  if (!baseUrl || !cleanup.model) {
    return yield* new SpeechToTextCleanupFailure({
      message: "Add the cleanup server URL and model in Settings → Speech to text.",
    });
  }
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(`${baseUrl}/chat/completions`).pipe(
        HttpClientRequest.setHeaders(
          cleanup.apiKey ? { authorization: `Bearer ${cleanup.apiKey}` } : {},
        ),
        HttpClientRequest.bodyJsonUnsafe({
          model: cleanup.model,
          temperature: 0,
          messages: [
            { role: "user", content: `${prompt}\n\nReply with only the cleaned message.` },
          ],
        }),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        Effect.map(response.json, (body) => ({ status: response.status, body })),
      ),
      Effect.timeout(CLEANUP_TIMEOUT),
      Effect.withTracerEnabled(false),
      Effect.mapError(
        () => new SpeechToTextCleanupFailure({ message: "Could not reach the cleanup model." }),
      ),
    );
  const text = readChatCompletionText(response.body);
  if (response.status < 200 || response.status >= 300 || text === null) {
    return yield* new SpeechToTextCleanupFailure({
      message: `The cleanup model failed (HTTP ${response.status}).`,
    });
  }
  return stripReasoning(text);
});

/**
 * Rewrites a raw transcript the way Wispr Flow-style tools do. Returns the transcript untouched
 * when cleanup is off; callers fall back to it when cleanup fails.
 */
export const cleanDictation = Effect.fn("SpeechToText.cleanDictation")(function* (input: {
  readonly settings: SpeechToTextSettings;
  readonly transcript: string;
  readonly conversation: DictationConversation;
  readonly textGenerationModel: ModelSelection;
  readonly textGeneration: TextGeneration.TextGeneration["Service"] | null;
  readonly cwd: string;
}) {
  const cleanup = input.settings.cleanup;
  const transcript = input.transcript.trim();
  if (cleanup.mode === null || transcript.length === 0) return transcript;
  const promptInput = {
    transcript,
    language: input.settings.language,
    vocabulary: input.settings.prompt,
    instructions: cleanup.instructions,
    conversation: cleanup.useThreadContext ? input.conversation : [],
  };

  let cleaned: string;
  if (cleanup.mode === "openai-compatible") {
    cleaned = yield* cleanWithChatCompletions(
      cleanup,
      buildDictationCleanupPrompt(promptInput).prompt,
    );
  } else {
    const runCleanup = input.textGeneration?.cleanDictation;
    if (!runCleanup) {
      return yield* new SpeechToTextCleanupFailure({
        message: "Text generation is not available on this environment.",
      });
    }
    cleaned = yield* runCleanup({
      ...promptInput,
      cwd: input.cwd,
      modelSelection: input.textGenerationModel,
    }).pipe(
      Effect.map((result) => result.text),
      Effect.timeout(CLEANUP_TIMEOUT),
      Effect.mapError(
        (error) =>
          new SpeechToTextCleanupFailure({
            message:
              "detail" in error && typeof error.detail === "string"
                ? error.detail
                : "The text generation model did not answer in time.",
          }),
      ),
    );
  }
  // An empty answer for real speech means the model refused or misread the task.
  return cleaned.length > 0 ? cleaned : transcript;
});
