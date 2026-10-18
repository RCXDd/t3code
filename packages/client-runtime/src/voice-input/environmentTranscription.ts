import {
  isSpeechToTextConfigured,
  SPEECH_TO_TEXT_MAX_AUDIO_BYTES,
  type ServerConfig,
  type SpeechToTextCreateUploadUrlInput,
} from "@t3tools/contracts";

import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceTranscriber,
} from "./transcription.ts";

/** Environment dictation needs a server that can transcribe and a configured provider. */
export function environmentSpeechToTextAvailable(
  config: Pick<ServerConfig, "environment" | "settings"> | null | undefined,
): boolean {
  return (
    config?.environment.capabilities.speechToText === true &&
    isSpeechToTextConfigured(config.settings.speechToText)
  );
}

export type EnvironmentTranscriptionResponse = {
  readonly status: number;
  readonly body: string;
};

export type EnvironmentVoiceTranscriberDependencies = {
  /** Used for transcript spacing; the provider's language comes from server settings. */
  readonly locale: string;
  readonly readRecording: (
    uri: string,
  ) => Promise<{ readonly mimeType: string; readonly sizeBytes: number }>;
  /** Mints the signed upload URL and resolves it against the environment's HTTP origin. */
  readonly createUploadUrl: (input: SpeechToTextCreateUploadUrlInput) => Promise<string>;
  /** POSTs the recording bytes and settles only after the request has stopped. */
  readonly upload: (input: {
    readonly url: string;
    readonly uri: string;
    readonly mimeType: string;
    readonly signal: AbortSignal;
  }) => Promise<EnvironmentTranscriptionResponse>;
};

function failure(message: string, cause?: unknown): VoiceTranscriptionError {
  return new VoiceTranscriptionError(
    "transcription-failed",
    message,
    cause === undefined ? { showMessage: true } : { cause, showMessage: true },
  );
}

/** The route answers `{ text }` on success and `{ error }` with a user-facing reason otherwise. */
export function parseEnvironmentTranscriptionResponse(
  response: EnvironmentTranscriptionResponse,
): string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(response.body);
  } catch {}
  const record =
    parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (response.status >= 200 && response.status < 300 && typeof record.text === "string") {
    return record.text;
  }
  throw failure(
    typeof record.error === "string" && record.error.length > 0
      ? record.error
      : `Transcription failed (HTTP ${response.status}).`,
  );
}

export function createEnvironmentVoiceTranscriber(
  dependencies: EnvironmentVoiceTranscriberDependencies,
): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: dependencies.locale,
        transcribe: async (uri, { signal }) => {
          throwIfVoiceTranscriptionAborted(signal);
          const recording = await dependencies.readRecording(uri);
          if (recording.sizeBytes > SPEECH_TO_TEXT_MAX_AUDIO_BYTES) {
            throw failure("This recording is too long to transcribe.");
          }
          throwIfVoiceTranscriptionAborted(signal);
          let url: string;
          try {
            url = await dependencies.createUploadUrl({
              mimeType: recording.mimeType,
              sizeBytes: recording.sizeBytes,
            });
          } catch (error) {
            throw failure(
              error instanceof Error && error.message
                ? error.message
                : "Could not reach this environment.",
              error,
            );
          }
          throwIfVoiceTranscriptionAborted(signal);
          let response: EnvironmentTranscriptionResponse;
          try {
            response = await dependencies.upload({
              url,
              uri,
              mimeType: recording.mimeType,
              signal,
            });
          } catch (error) {
            throwIfVoiceTranscriptionAborted(signal);
            throw failure("Could not upload the recording to this environment.", error);
          }
          throwIfVoiceTranscriptionAborted(signal);
          return parseEnvironmentTranscriptionResponse(response);
        },
      };
    },
  };
}
