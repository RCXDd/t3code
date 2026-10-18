import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { WebVoiceRecorder } from "./webVoiceRecorder";

function fakeStream() {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  return {
    track,
    stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream,
  };
}

function stubMicrophone() {
  const { promise, resolve } = (() => {
    let resolve!: (stream: MediaStream) => void;
    const promise = new Promise<MediaStream>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  })();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => promise } });
  return resolve;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebVoiceRecorder", () => {
  it("closes a microphone granted after dictation was cancelled", async () => {
    const grant = stubMicrophone();
    const recorder = new WebVoiceRecorder(() => {});
    const permission = recorder.requestPermission();
    await recorder.release();
    const { stream, track } = fakeStream();
    grant(stream);

    expect(await permission).toEqual({ granted: false, canAskAgain: true });
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("keeps the microphone it opened for the current start until release", async () => {
    const grant = stubMicrophone();
    const recorder = new WebVoiceRecorder(() => {});
    const permission = recorder.requestPermission();
    const { stream, track } = fakeStream();
    grant(stream);

    expect(await permission).toEqual({ granted: true, canAskAgain: true });
    expect(track.stop).not.toHaveBeenCalled();
    await recorder.release();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
