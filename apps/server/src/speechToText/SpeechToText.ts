import {
  resolveSpeechToTextProviderSettings,
  SPEECH_TO_TEXT_PROVIDERS,
  type SpeechToTextProvider,
  type SpeechToTextSettings,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";

// Self-hosted Whisper servers can take a while to load a model on the first request.
const TRANSCRIPTION_TIMEOUT = "120 seconds";
const ERROR_DETAIL_MAX_LENGTH = 300;

export class SpeechToTextFailure extends Data.TaggedError("SpeechToTextFailure")<{
  /** HTTP status for the client: 4xx when the setup is wrong, 502 when the service failed. */
  readonly status: number;
  readonly message: string;
}> {}

export type SpeechToTextAudio = {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
};

export type SpeechToTextRequest = {
  readonly provider: SpeechToTextProvider;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Multipart fields sent alongside the `file` part. */
  readonly fields: ReadonlyArray<readonly [name: string, value: string]>;
  readonly fileName: string;
};

const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

/** Whisper-style APIs pick the decoder from the file name, so it must match the container. */
export function speechToTextFileName(mimeType: string): string {
  const essence = mimeType.split(";")[0]!.trim().toLowerCase();
  return `dictation.${AUDIO_EXTENSIONS[essence] ?? "webm"}`;
}

/** Builds the provider request, or explains which setting is missing. */
export function resolveSpeechToTextRequest(
  settings: SpeechToTextSettings,
  mimeType: string,
): SpeechToTextRequest | SpeechToTextFailure {
  const provider = settings.provider;
  if (provider === null) {
    return new SpeechToTextFailure({
      status: 409,
      message: "Speech to text is turned off for this environment.",
    });
  }
  const info = SPEECH_TO_TEXT_PROVIDERS[provider];
  const configured = resolveSpeechToTextProviderSettings(settings, provider);
  const apiKey = configured.apiKey;
  if (info.apiKeyRequired && apiKey.length === 0) {
    return new SpeechToTextFailure({
      status: 409,
      message: `Add your ${info.label} API key in Settings → Speech to text.`,
    });
  }
  const baseUrl = (configured.baseUrl || info.defaultBaseUrl).replace(/\/+$/, "");
  if (baseUrl.length === 0) {
    return new SpeechToTextFailure({
      status: 409,
      message: "Add the server URL in Settings → Speech to text.",
    });
  }
  const model = configured.model || info.defaultModel;
  if (model.length === 0 && provider !== "xai") {
    return new SpeechToTextFailure({
      status: 409,
      message: "Choose a model in Settings → Speech to text.",
    });
  }
  const language = settings.language;
  const prompt = info.supportsPrompt ? settings.prompt : "";
  const bearer: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const fileName = speechToTextFileName(mimeType);

  switch (provider) {
    case "xai":
      return {
        provider,
        url: `${baseUrl}/stt`,
        headers: bearer,
        fields: [["format", "true"], ...(language ? [["language", language] as const] : [])],
        fileName,
      };
    case "elevenlabs":
      return {
        provider,
        url: `${baseUrl}/speech-to-text`,
        headers: { "xi-api-key": apiKey },
        fields: [
          ["model_id", model],
          ["tag_audio_events", "false"],
          ...(language ? [["language_code", language] as const] : []),
        ],
        fileName,
      };
    case "openai":
    case "groq":
    case "mistral":
    case "deepinfra":
    case "openai-compatible":
      return {
        provider,
        url: `${baseUrl}/audio/transcriptions`,
        headers: bearer,
        fields: [
          ["model", model],
          ["response_format", "json"],
          ...(language ? [["language", language] as const] : []),
          ...(prompt ? [["prompt", prompt] as const] : []),
        ],
        fileName,
      };
  }
}

/**
 * Some services and proxies echo the submitted credential in authentication errors; their
 * messages reach logs and clients, so the configured key is masked first.
 */
export function redactSpeechToTextSecret(message: string, apiKey: string): string {
  return apiKey.length > 0 ? message.replaceAll(apiKey, "[redacted]") : message;
}

function readErrorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const candidate of [record.error, record.detail, record]) {
        if (typeof candidate === "string" && candidate.trim()) {
          return candidate.trim().slice(0, ERROR_DETAIL_MAX_LENGTH);
        }
        if (candidate !== null && typeof candidate === "object") {
          const message = (candidate as Record<string, unknown>).message;
          if (typeof message === "string" && message.trim()) {
            return message.trim().slice(0, ERROR_DETAIL_MAX_LENGTH);
          }
        }
      }
    }
  } catch {}
  return body.trim().slice(0, ERROR_DETAIL_MAX_LENGTH);
}

/** Every supported service answers with JSON carrying the transcript in `text`. */
export function parseSpeechToTextResponse(
  provider: SpeechToTextProvider,
  status: number,
  body: string,
): string | SpeechToTextFailure {
  const label = SPEECH_TO_TEXT_PROVIDERS[provider].label;
  if (status < 200 || status >= 300) {
    const detail = readErrorDetail(body);
    return new SpeechToTextFailure({
      status: 502,
      message: `${label} rejected the recording (HTTP ${status})${detail ? `: ${detail}` : "."}`,
    });
  }
  try {
    const parsed: unknown = JSON.parse(body);
    const text =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).text
        : undefined;
    if (typeof text === "string") return text.trim();
  } catch {}
  return new SpeechToTextFailure({
    status: 502,
    message: `${label} returned a response without a transcript.`,
  });
}

export const transcribeSpeech = Effect.fn("SpeechToText.transcribe")(function* (
  settings: SpeechToTextSettings,
  audio: SpeechToTextAudio,
) {
  const request = resolveSpeechToTextRequest(settings, audio.mimeType);
  if (request instanceof SpeechToTextFailure) return yield* request;

  const form = new FormData();
  for (const [name, value] of request.fields) form.append(name, value);
  form.append(
    "file",
    new Blob([audio.bytes as Uint8Array<ArrayBuffer>], { type: audio.mimeType }),
    request.fileName,
  );

  const label = SPEECH_TO_TEXT_PROVIDERS[request.provider].label;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(request.url).pipe(
        HttpClientRequest.setHeaders(request.headers),
        HttpClientRequest.bodyFormData(form),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        Effect.map(response.text, (body) => ({ status: response.status, body })),
      ),
      Effect.timeout(TRANSCRIPTION_TIMEOUT),
      // Request spans would record the API key header and the provider URL.
      Effect.withTracerEnabled(false),
      Effect.mapError(
        () =>
          new SpeechToTextFailure({
            status: 502,
            message: `Could not reach ${label}. Check the server URL and network.`,
          }),
      ),
    );

  const transcript = parseSpeechToTextResponse(request.provider, response.status, response.body);
  if (transcript instanceof SpeechToTextFailure) {
    const apiKey = resolveSpeechToTextProviderSettings(settings, request.provider).apiKey;
    return yield* new SpeechToTextFailure({
      status: transcript.status,
      message: redactSpeechToTextSecret(transcript.message, apiKey),
    });
  }
  return transcript;
});
