import { describe, expect, it, vi } from "vite-plus/test";

import {
  createEnvironmentVoiceTranscriber,
  parseEnvironmentTranscriptionResponse,
} from "./environmentTranscription.ts";
import { VoiceTranscriptionError } from "./transcription.ts";

const signal = () => new AbortController().signal;

describe("createEnvironmentVoiceTranscriber", () => {
  it("uploads the recording to the minted URL and returns the transcript", async () => {
    const createUploadUrl = vi.fn(
      async () => "https://env.test/api/speech-to-text/transcriptions/t",
    );
    const upload = vi.fn(async () => ({ status: 200, body: '{"text":"Hallo zusammen"}' }));
    const transcriber = createEnvironmentVoiceTranscriber({
      locale: "de-DE",
      readRecording: async () => ({ mimeType: "audio/webm", sizeBytes: 42 }),
      createUploadUrl,
      upload,
    });
    const prepared = await transcriber.prepare({ signal: signal() });
    expect(prepared.locale).toBe("de-DE");
    await expect(prepared.transcribe("blob:recording", { signal: signal() })).resolves.toBe(
      "Hallo zusammen",
    );
    expect(createUploadUrl).toHaveBeenCalledWith({ mimeType: "audio/webm", sizeBytes: 42 });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://env.test/api/speech-to-text/transcriptions/t",
        uri: "blob:recording",
        mimeType: "audio/webm",
      }),
    );
  });

  it("does not upload after cancellation", async () => {
    const upload = vi.fn();
    const controller = new AbortController();
    const transcriber = createEnvironmentVoiceTranscriber({
      locale: "en",
      readRecording: async () => ({ mimeType: "audio/webm", sizeBytes: 1 }),
      createUploadUrl: async () => {
        controller.abort();
        return "https://env.test/upload";
      },
      upload,
    });
    const prepared = await transcriber.prepare({ signal: signal() });
    await expect(
      prepared.transcribe("blob:x", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("parseEnvironmentTranscriptionResponse", () => {
  it("shows the environment's reason to the user", () => {
    let thrown: unknown;
    try {
      parseEnvironmentTranscriptionResponse({
        status: 502,
        body: '{"error":"OpenAI rejected the recording (HTTP 401): Incorrect API key provided."}',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VoiceTranscriptionError);
    expect((thrown as VoiceTranscriptionError).showMessage).toBe(true);
    expect((thrown as VoiceTranscriptionError).message).toContain("Incorrect API key");
  });

  it("keeps the raw transcript and reports why cleanup failed", async () => {
    const onCleanupError = vi.fn();
    const transcriber = createEnvironmentVoiceTranscriber({
      locale: "de",
      readRecording: async () => ({ mimeType: "audio/webm", sizeBytes: 1 }),
      createUploadUrl: async () => "https://env.test/upload",
      upload: async () => ({
        status: 200,
        body: '{"text":"äh hallo","cleanupError":"The cleanup model failed (HTTP 500)."}',
      }),
      onCleanupError,
    });
    const prepared = await transcriber.prepare({ signal: signal() });
    await expect(prepared.transcribe("blob:x", { signal: signal() })).resolves.toBe("äh hallo");
    expect(onCleanupError).toHaveBeenCalledWith("The cleanup model failed (HTTP 500).");
  });

  it("falls back to the status when the body is not JSON", () => {
    expect(() =>
      parseEnvironmentTranscriptionResponse({ status: 504, body: "Gateway Timeout" }),
    ).toThrow("Transcription failed (HTTP 504).");
  });
});
