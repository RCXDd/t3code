import { AsyncResult, Atom } from "effect/reactivity";

import { parakeetModelAtom } from "../../native/onDeviceTranscription";
import { mobilePreferencesAtom } from "../../state/preferences";

/** A string so subscribers re-render only when the engine or the model's readiness changes. */
export const localVoiceEngineStateAtom = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  const engine = AsyncResult.isSuccess(preferences)
    ? (preferences.value.voiceTranscriptionEngine ?? "default")
    : "default";
  return `${engine}:${get(parakeetModelAtom).status}`;
}).pipe(Atom.withLabel("mobile-local-voice-engine-state"));
