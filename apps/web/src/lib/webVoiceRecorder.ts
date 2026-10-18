import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";

// Opus in WebM is small and every transcription service accepts it; Safari records MP4/AAC.
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

const recordings = new Map<string, Blob>();

export function webDictationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/** The controller identifies recordings by URI; on the web that is an object URL. */
export function readWebVoiceRecording(uri: string): Blob | null {
  return recordings.get(uri) ?? null;
}

export function deleteWebVoiceRecording(uri: string): void {
  if (!recordings.delete(uri)) return;
  URL.revokeObjectURL(uri);
}

function pickMimeType(): string | undefined {
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export class WebVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private readonly onStatus: (status: VoiceRecorderStatus) => void;

  constructor(onStatus: (status: VoiceRecorderStatus) => void) {
    this.onStatus = onStatus;
  }

  /** Opens the microphone; the browser asks for permission on first use. */
  async requestPermission(): Promise<{ granted: boolean; canAskAgain: boolean }> {
    if (this.stream) return { granted: true, canAskAgain: true };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      for (const track of this.stream.getAudioTracks()) {
        track.addEventListener("ended", () => this.fail("The microphone was disconnected."));
      }
      return { granted: true, canAskAgain: true };
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      // A denied prompt keeps failing until the user changes the site permission.
      const denied = name === "NotAllowedError" || name === "SecurityError";
      return { granted: false, canAskAgain: !denied };
    }
  }

  async prepareToRecordAsync(): Promise<void> {
    if (!this.stream) throw new Error("The microphone is not open.");
    this.uri = null;
    this.chunks = [];
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    recorder.addEventListener("error", () => this.fail("Voice recording failed."));
    this.recorder = recorder;

    this.audioContext = new AudioContext();
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 512;
    this.audioContext.createMediaStreamSource(this.stream).connect(analyser);
    this.analyser = analyser;
    this.samples = new Float32Array(analyser.fftSize);
  }

  record({ forDuration }: { readonly forDuration: number }): void {
    if (!this.recorder) return;
    this.recorder.start();
    this.limitTimer = setTimeout(() => {
      void this.stop().then(() =>
        this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri }),
      );
    }, forDuration * 1000);
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopRecorder().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /** Microphone loudness from 0 to 1 for the waveform. */
  level(): number {
    if (!this.analyser || !this.samples) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 4);
  }

  /** Closes the microphone so the browser's recording indicator goes away. */
  async release(): Promise<void> {
    this.clearLimit();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.analyser = null;
    this.samples = null;
    const audioContext = this.audioContext;
    this.audioContext = null;
    await audioContext?.close().catch(() => undefined);
  }

  private async stopRecorder(): Promise<void> {
    this.clearLimit();
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorder = null;
    if (recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }
    if (this.chunks.length === 0) return;
    const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
    this.chunks = [];
    const uri = URL.createObjectURL(blob);
    recordings.set(uri, blob);
    this.uri = uri;
  }

  private fail(message: string): void {
    if (!this.recorder) return;
    void this.stop().then(() =>
      this.onStatus({ isFinished: false, hasError: true, error: message, url: this.uri }),
    );
  }

  private clearLimit(): void {
    if (this.limitTimer === null) return;
    clearTimeout(this.limitTimer);
    this.limitTimer = null;
  }
}
