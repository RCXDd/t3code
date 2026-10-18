import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  return null;
}

export function isAppleTranscriptionAvailable(): boolean {
  return false;
}
