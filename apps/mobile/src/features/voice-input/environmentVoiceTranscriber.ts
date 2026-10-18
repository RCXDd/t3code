import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  createEnvironmentVoiceTranscriber,
  environmentSpeechToTextAvailable,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { environmentSession, readEnvironmentScope } from "../../state/session";

// expo-audio's HIGH_QUALITY preset records AAC in an MPEG-4 container on both platforms.
const RECORDING_MIME_TYPE = "audio/mp4";

export function environmentVoiceTranscriptionAvailable(environmentId: EnvironmentId): boolean {
  return (
    readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) &&
    environmentSpeechToTextAvailable(
      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)),
    )
  );
}

/** Sends recordings to the environment when it has a speech-to-text service set up. */
export function getEnvironmentVoiceTranscriber(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): VoiceTranscriber | null {
  if (!environmentVoiceTranscriptionAvailable(environmentId)) return null;
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
  return createEnvironmentVoiceTranscriber({
    locale:
      config?.settings.speechToText.language || Intl.DateTimeFormat().resolvedOptions().locale,
    readRecording: async (uri) => {
      const { File } = await import("expo-file-system");
      return { mimeType: RECORDING_MIME_TYPE, sizeBytes: new File(uri).size };
    },
    createUploadUrl: async (input) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.createSpeechToTextUploadUrl,
        { environmentId, input: { ...input, ...(threadId ? { threadId } : {}) } },
        { reportFailure: false },
      );
      if (result._tag !== "Success") {
        const error = squashAtomCommandFailure(result);
        throw new Error(
          error instanceof Error && error.message
            ? error.message
            : "Could not reach this environment.",
        );
      }
      // Read at upload time: a reconnect can move the environment to another origin.
      const connection = Option.getOrNull(
        appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      const url = connection
        ? resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl)
        : null;
      if (!url) throw new Error("This environment is not connected.");
      return url;
    },
    upload: async ({ url, uri, mimeType, signal }) => {
      const { File, UploadType } = await import("expo-file-system");
      const result = await new File(uri).upload(url, {
        httpMethod: "POST",
        uploadType: UploadType.BINARY_CONTENT,
        headers: { "Content-Type": mimeType },
        signal,
      });
      return { status: result.status, body: result.body };
    },
  });
}
