import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ForwardCompatibleNullable, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/**
 * Hosted speech-to-text services the environment can send dictation audio to.
 * `openai-compatible` covers self-hosted Whisper servers (speaches,
 * faster-whisper-server, whisper.cpp) and any other `/audio/transcriptions` API.
 */
export const SpeechToTextProvider = Schema.Literals([
  "openai",
  "groq",
  "mistral",
  "xai",
  "elevenlabs",
  "deepinfra",
  "openai-compatible",
]);
export type SpeechToTextProvider = typeof SpeechToTextProvider.Type;

export type SpeechToTextProviderInfo = {
  readonly label: string;
  /** Empty when the service picks its own model. */
  readonly defaultModel: string;
  readonly suggestedModels: ReadonlyArray<string>;
  /** Empty when the user must supply one. */
  readonly defaultBaseUrl: string;
  readonly apiKeyRequired: boolean;
  readonly apiKeyUrl: string | null;
  /** Whether the service accepts a vocabulary/style prompt. */
  readonly supportsPrompt: boolean;
};

export const SPEECH_TO_TEXT_PROVIDERS: Readonly<
  Record<SpeechToTextProvider, SpeechToTextProviderInfo>
> = {
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-4o-mini-transcribe",
    suggestedModels: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"],
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyRequired: true,
    apiKeyUrl: "https://platform.openai.com/api-keys",
    supportsPrompt: true,
  },
  groq: {
    label: "Groq",
    defaultModel: "whisper-large-v3-turbo",
    suggestedModels: ["whisper-large-v3-turbo", "whisper-large-v3"],
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    apiKeyRequired: true,
    apiKeyUrl: "https://console.groq.com/keys",
    supportsPrompt: true,
  },
  mistral: {
    label: "Mistral (Voxtral)",
    defaultModel: "voxtral-mini-latest",
    suggestedModels: ["voxtral-mini-latest"],
    defaultBaseUrl: "https://api.mistral.ai/v1",
    apiKeyRequired: true,
    apiKeyUrl: "https://console.mistral.ai/api-keys",
    supportsPrompt: false,
  },
  xai: {
    label: "xAI (Grok)",
    defaultModel: "",
    suggestedModels: [],
    defaultBaseUrl: "https://api.x.ai/v1",
    apiKeyRequired: true,
    apiKeyUrl: "https://console.x.ai",
    supportsPrompt: false,
  },
  elevenlabs: {
    label: "ElevenLabs Scribe",
    defaultModel: "scribe_v2",
    suggestedModels: ["scribe_v2", "scribe_v1"],
    defaultBaseUrl: "https://api.elevenlabs.io/v1",
    apiKeyRequired: true,
    apiKeyUrl: "https://elevenlabs.io/app/settings/api-keys",
    supportsPrompt: false,
  },
  deepinfra: {
    label: "DeepInfra",
    defaultModel: "openai/whisper-large-v3-turbo",
    suggestedModels: ["openai/whisper-large-v3-turbo", "openai/whisper-large-v3"],
    defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
    apiKeyRequired: true,
    apiKeyUrl: "https://deepinfra.com/dash/api_keys",
    supportsPrompt: true,
  },
  "openai-compatible": {
    label: "Custom (OpenAI-compatible)",
    defaultModel: "",
    suggestedModels: [],
    defaultBaseUrl: "",
    apiKeyRequired: false,
    apiKeyUrl: null,
    supportsPrompt: true,
  },
};

export const SpeechToTextProviderSettings = Schema.Struct({
  /** Empty uses the provider's default model. */
  model: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Empty uses the provider's default endpoint. */
  baseUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // Declared inline rather than through `secretSetting` from settings.ts, which imports this module.
  apiKey: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("")), (schema) =>
    schema.annotateKey({ settingsSecret: true }),
  ),
});
export type SpeechToTextProviderSettings = typeof SpeechToTextProviderSettings.Type;

export const SpeechToTextSettings = Schema.Struct({
  /** Null turns environment transcription off. */
  provider: ForwardCompatibleNullable(SpeechToTextProvider).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** ISO-639-1 hint such as "en" or "de". Empty lets the service detect the language. */
  language: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Vocabulary and style hint for services that support one. */
  prompt: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  // Keyed by provider so switching services keeps each one's key and model.
  providers: Schema.Record(Schema.String, SpeechToTextProviderSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type SpeechToTextSettings = typeof SpeechToTextSettings.Type;

export const SpeechToTextSettingsPatch = Schema.Struct({
  provider: Schema.optionalKey(Schema.NullOr(SpeechToTextProvider)),
  language: Schema.optionalKey(TrimmedString),
  prompt: Schema.optionalKey(TrimmedString),
  providers: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        model: Schema.optionalKey(TrimmedString),
        baseUrl: Schema.optionalKey(TrimmedString),
        apiKey: Schema.optionalKey(TrimmedString),
      }),
    ),
  ),
});
export type SpeechToTextSettingsPatch = typeof SpeechToTextSettingsPatch.Type;

export function resolveSpeechToTextProviderSettings(
  settings: SpeechToTextSettings,
  provider: SpeechToTextProvider,
): SpeechToTextProviderSettings {
  return Object.hasOwn(settings.providers, provider)
    ? settings.providers[provider]!
    : { model: "", baseUrl: "", apiKey: "" };
}

/** Whether clients should offer environment dictation; the server still validates the request. */
export function isSpeechToTextConfigured(settings: SpeechToTextSettings): boolean {
  const provider = settings.provider;
  if (provider === null) return false;
  const info = SPEECH_TO_TEXT_PROVIDERS[provider];
  const configured = resolveSpeechToTextProviderSettings(settings, provider);
  if (info.apiKeyRequired && configured.apiKey.length === 0) return false;
  if (info.defaultBaseUrl.length === 0 && configured.baseUrl.length === 0) return false;
  if (info.defaultModel.length === 0 && provider !== "xai" && configured.model.length === 0) {
    return false;
  }
  return true;
}

/** Upper bound on one dictation upload; matches the OpenAI and Groq file limit. */
export const SPEECH_TO_TEXT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const SpeechToTextTranscriptionResult = Schema.Struct({
  text: Schema.String,
});
export type SpeechToTextTranscriptionResult = typeof SpeechToTextTranscriptionResult.Type;

/** Upload URLs are minted when recording stops, so they only need to outlive the upload. */
export const SPEECH_TO_TEXT_UPLOAD_URL_TTL_MS = 2 * 60_000;

export const SpeechToTextCreateUploadUrlInput = Schema.Struct({
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  sizeBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: SPEECH_TO_TEXT_MAX_AUDIO_BYTES }),
  ),
});
export type SpeechToTextCreateUploadUrlInput = typeof SpeechToTextCreateUploadUrlInput.Type;

export const SpeechToTextCreateUploadUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
});
export type SpeechToTextCreateUploadUrlResult = typeof SpeechToTextCreateUploadUrlResult.Type;

export class SpeechToTextUnavailableError extends Schema.TaggedError<SpeechToTextUnavailableError>()(
  "SpeechToTextUnavailableError",
  {
    reason: Schema.Literals(["not-configured", "signing-key"]),
  },
) {
  override get message(): string {
    return this.reason === "not-configured"
      ? "Speech to text is not set up for this environment."
      : "Failed to load the speech-to-text upload signing key.";
  }
}
