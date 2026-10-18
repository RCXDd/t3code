import type { VoiceTranscriptionEngine } from "../persistence/mobile-preferences";

/**
 * The preferred engine wins when it can run; otherwise the other on-device engine fills in, so
 * choosing Parakeet before its download finishes, or Apple on an older iPhone, never turns
 * dictation off.
 */
export function resolveVoiceTranscriptionEngine(input: {
  readonly preferred: VoiceTranscriptionEngine | undefined;
  readonly appleAvailable: boolean;
  readonly parakeetReady: boolean;
}): VoiceTranscriptionEngine | null {
  const available = (engine: VoiceTranscriptionEngine) =>
    engine === "apple" ? input.appleAvailable : input.parakeetReady;
  const order: readonly VoiceTranscriptionEngine[] =
    input.preferred === "parakeet" ? ["parakeet", "apple"] : ["apple", "parakeet"];
  return order.find(available) ?? null;
}
