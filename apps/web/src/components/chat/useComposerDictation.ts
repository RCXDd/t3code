import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  createEnvironmentVoiceTranscriber,
  environmentSpeechToTextAvailable,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import {
  deleteWebVoiceRecording,
  readWebVoiceRecording,
  webDictationSupported,
  WebVoiceRecorder,
} from "../../lib/webVoiceRecorder";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { readPreparedConnection, useEnvironmentScope } from "../../state/session";
import { toastManager } from "../ui/toast";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

type DraftSelection = { readonly start: number; readonly end: number };

export type ComposerDictation = {
  readonly available: boolean;
  readonly state: VoiceInputState;
  readonly blocksSubmission: boolean;
  readonly recorder: WebVoiceRecorder;
  readonly start: () => void;
  readonly stop: () => void;
  readonly cancel: () => void;
};

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function createDictationSession(input: {
  readonly readEnvironmentId: () => EnvironmentId;
  readonly readThreadId: () => ThreadId | null;
  readonly readLanguage: () => string;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (text: string, selection: DraftSelection) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
}) {
  const recorder = new WebVoiceRecorder((status) => {
    void controller.handleRecorderStatus(status);
  });
  const controller: VoiceInputController = new VoiceInputController({
    recorder,
    getTranscriber: () => {
      const environmentId = input.readEnvironmentId();
      const threadId = input.readThreadId();
      return createEnvironmentVoiceTranscriber({
        locale: input.readLanguage() || navigator.language,
        readRecording: async (uri) => {
          const blob = readWebVoiceRecording(uri);
          if (!blob) throw new Error("The recording is no longer available.");
          return { mimeType: blob.type || "audio/webm", sizeBytes: blob.size };
        },
        createUploadUrl: async (uploadInput) => {
          const result = await runAtomCommand(
            appAtomRegistry,
            serverEnvironment.createSpeechToTextUploadUrl,
            {
              environmentId,
              input: { ...uploadInput, ...(threadId ? { threadId } : {}) },
            },
            { reportFailure: false },
          );
          if (result._tag !== "Success") {
            throw new Error(
              failureMessage(squashAtomCommandFailure(result), "Could not reach this environment."),
            );
          }
          const connection = readPreparedConnection(environmentId);
          const url = connection
            ? resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl)
            : null;
          if (!url) throw new Error("This environment is not connected.");
          return url;
        },
        upload: async ({ url, uri, mimeType, signal }) => {
          const blob = readWebVoiceRecording(uri);
          if (!blob) throw new Error("The recording is no longer available.");
          const response = await fetch(url, {
            method: "POST",
            body: blob,
            headers: { "content-type": mimeType },
            signal,
          });
          return { status: response.status, body: await response.text() };
        },
      });
    },
    requestPermission: () => recorder.requestPermission(),
    configureRecording: async () => {},
    releaseRecording: () => recorder.release(),
    deleteRecording: deleteWebVoiceRecording,
    readDraft: input.readDraft,
    commitDraft: input.commitDraft,
    onStateChange: (next) => {
      // Permission is granted before the controller configures recording, so a failure in
      // between would otherwise leave the browser's microphone indicator on.
      if (next.phase === "idle" || next.phase === "error") void recorder.release();
      input.onStateChange(next);
    },
  });
  return { controller, recorder };
}

export function useComposerDictation(input: {
  readonly environmentId: EnvironmentId;
  /** Lets cleanup spell names the way the thread does. */
  readonly threadId: ThreadId | null;
  readonly ownerKey: string;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (text: string, selection: DraftSelection) => void;
}): ComposerDictation {
  const config = useAtomValue(serverEnvironment.configValueAtom(input.environmentId));
  const canOperate = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const available =
    canOperate && webDictationSupported() && environmentSpeechToTextAvailable(config);
  const language = config?.settings.speechToText.language ?? "";
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);

  // The session outlives renders and reads the latest props through these forwarders.
  const readEnvironmentId = useStableCallback(() => input.environmentId);
  const readThreadId = useStableCallback(() => input.threadId);
  const readLanguage = useStableCallback(() => language);
  const readDraft = useStableCallback(() => input.readDraft());
  const commitDraft = useStableCallback((text: string, selection: DraftSelection) =>
    input.commitDraft(text, selection),
  );
  const [{ controller, recorder }] = useState(() =>
    createDictationSession({
      readEnvironmentId,
      readThreadId,
      readLanguage,
      readDraft,
      commitDraft,
      onStateChange: setState,
    }),
  );

  useEffect(() => () => controller.dispose(), [controller]);

  // Another client can turn the service off mid-recording; stop rather than keep the mic open.
  useEffect(() => {
    if (!available) controller.cancel();
  }, [available, controller]);

  const ownerKey = input.ownerKey;
  const previousOwnerKey = useRef(ownerKey);
  useEffect(() => {
    if (previousOwnerKey.current === ownerKey) return;
    previousOwnerKey.current = ownerKey;
    controller.ownerChanged();
  }, [controller, ownerKey]);

  const error = state.phase === "error" ? state.error : null;
  useEffect(() => {
    if (!error) return;
    toastManager.add({ type: "error", title: "Dictation failed", description: error });
  }, [error]);

  const blocksSubmission = voiceInputBlocksSubmission(state);
  return {
    // An active session keeps its controls until it settles, even if the service went away.
    available: available || blocksSubmission,
    state,
    blocksSubmission,
    recorder,
    start: () => void controller.start(),
    stop: () => void controller.stop(),
    cancel: () => controller.cancel(),
  };
}
