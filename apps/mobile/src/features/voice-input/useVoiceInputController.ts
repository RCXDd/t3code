import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import { useAtomValue } from "@effect/atom-react";
import { environmentSpeechToTextAvailable } from "@t3tools/client-runtime/voice-input";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const NO_SERVER_CONFIG_ATOM = Atom.make(null);

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly label: string;
  /** Lets the environment's speech-to-text service transcribe this draft when one is set up. */
  readonly environmentId: EnvironmentId | null;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const global = useGlobalVoiceInput();
  const environmentConfig = useAtomValue(
    input.environmentId
      ? serverEnvironment.configValueAtom(input.environmentId)
      : NO_SERVER_CONFIG_ATOM,
  );
  const canOperate = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const environmentAvailable = canOperate && environmentSpeechToTextAvailable(environmentConfig);
  const { setOwnerFocused, session } = global;
  const latestInput = useRef(input);
  latestInput.current = input;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      setOwnerFocused(ownerKey, true);
      return () => setOwnerFocused(ownerKey, false);
    }, [input.ownerKey, setOwnerFocused]),
  );

  const start = useCallback(() => {
    const captured = latestInput.current;
    if (!captured.ownerKey || captured.disabled) return;
    void session.start({
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
          }
        },
        captured.selection,
        captured.subscribeToDraftChanges,
      ),
      label: captured.label,
      environmentId: captured.environmentId,
    });
  }, [session]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  return {
    isAvailable:
      (global.isLocallyAvailable || environmentAvailable) &&
      (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    cancel: global.cancel,
  };
}
