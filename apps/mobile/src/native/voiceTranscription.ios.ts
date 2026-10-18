import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { File } from "expo-file-system";
import { AsyncResult } from "effect/reactivity";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

import { resolveVoiceTranscriptionEngine } from "../lib/voiceTranscriptionEngine";
import { appAtomRegistry } from "../state/atom-registry";
import { mobilePreferencesAtom } from "../state/preferences";
import { parakeetModelAtom, parakeetModule } from "./onDeviceTranscription";

function getDeviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function wrapError(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  cause: unknown,
): VoiceTranscriptionError {
  if (cause instanceof VoiceTranscriptionError) {
    return cause;
  }

  return new VoiceTranscriptionError(code, message, { cause });
}

function getNativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

export function isAppleTranscriptionAvailable(): boolean {
  return AppleTranscription.isAvailable(getDeviceLocale());
}

/** Read when dictation starts, so changing the engine does not re-render every composer. */
export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  const locale = getDeviceLocale();
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  const engine = resolveVoiceTranscriptionEngine({
    preferred: AsyncResult.isSuccess(preferences)
      ? preferences.value.voiceTranscriptionEngine
      : undefined,
    appleAvailable: AppleTranscription.isAvailable(locale),
    parakeetReady: appAtomRegistry.get(parakeetModelAtom).status === "ready",
  });
  if (engine === "parakeet") {
    return { prepare: (options) => prepareParakeetTranscription(locale, options) };
  }
  if (engine === "apple") {
    return { prepare: (options) => prepareVoiceTranscription(locale, options) };
  }
  return null;
}

async function prepareParakeetTranscription(
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  const module = parakeetModule();
  if (!module) {
    throw new VoiceTranscriptionError("unavailable", "Parakeet is not available in this build.");
  }
  throwIfVoiceTranscriptionAborted(signal);
  try {
    // Loading compiles the model for the Neural Engine once per launch, before recording starts.
    await module.prepare();
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("preparation-failed", "Parakeet could not be loaded.", error);
  }
  throwIfVoiceTranscriptionAborted(signal);
  return {
    // Parakeet detects the spoken language itself; the device locale only drives spacing.
    locale,
    transcribe: async (uri, { signal }) => {
      try {
        throwIfVoiceTranscriptionAborted(signal);
        const text = await module.transcribe(uri);
        throwIfVoiceTranscriptionAborted(signal);
        return text.trim();
      } catch (error) {
        throwIfVoiceTranscriptionAborted(signal);
        throw wrapError("transcription-failed", "Voice transcription failed.", error);
      }
    },
  };
}

async function prepareVoiceTranscription(
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!AppleTranscription.isAvailable(locale)) {
    throw new VoiceTranscriptionError(
      "unavailable",
      "Voice transcription requires a supported device with iOS 26 or later.",
    );
  }

  try {
    const supportedLocale = await AppleTranscription.prepare(locale);
    throwIfVoiceTranscriptionAborted(signal);
    return {
      locale: supportedLocale,
      transcribe: (uri, options) => transcribeVoiceRecording(uri, supportedLocale, options),
    };
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (getNativeErrorCode(error) === "AppleTranscriptionUnsupportedLocale") {
      throw new VoiceTranscriptionError(
        "unsupported-locale",
        "Voice transcription does not support this device language.",
        { cause: error },
      );
    }

    throw wrapError(
      "preparation-failed",
      "Voice transcription could not prepare this language.",
      error,
    );
  }
}

async function transcribeVoiceRecording(
  uri: string,
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  try {
    throwIfVoiceTranscriptionAborted(signal);
    const audio = await new File(uri).arrayBuffer();
    throwIfVoiceTranscriptionAborted(signal);
    const result = await AppleTranscription.transcribe(audio, locale);
    throwIfVoiceTranscriptionAborted(signal);
    return result.segments
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("transcription-failed", "Voice transcription failed.", error);
  }
}
