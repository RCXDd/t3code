import { describe, expect, it } from "vite-plus/test";

import { resolveVoiceTranscriptionEngine } from "./voiceTranscriptionEngine";

describe("resolveVoiceTranscriptionEngine", () => {
  it("keeps Apple as the default when it is available", () => {
    expect(
      resolveVoiceTranscriptionEngine({
        preferred: undefined,
        appleAvailable: true,
        parakeetReady: true,
      }),
    ).toBe("apple");
  });

  it("uses Parakeet when chosen and downloaded", () => {
    expect(
      resolveVoiceTranscriptionEngine({
        preferred: "parakeet",
        appleAvailable: true,
        parakeetReady: true,
      }),
    ).toBe("parakeet");
  });

  it("falls back to the other engine instead of turning dictation off", () => {
    expect(
      resolveVoiceTranscriptionEngine({
        preferred: "parakeet",
        appleAvailable: true,
        parakeetReady: false,
      }),
    ).toBe("apple");
    // An iPhone before iOS 26 has no Apple engine but can still dictate with Parakeet.
    expect(
      resolveVoiceTranscriptionEngine({
        preferred: "apple",
        appleAvailable: false,
        parakeetReady: true,
      }),
    ).toBe("parakeet");
    expect(
      resolveVoiceTranscriptionEngine({
        preferred: undefined,
        appleAvailable: false,
        parakeetReady: false,
      }),
    ).toBeNull();
  });
});
