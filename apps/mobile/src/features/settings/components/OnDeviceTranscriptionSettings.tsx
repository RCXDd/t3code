import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { AppText as Text } from "../../../components/ui/AppText";
import {
  deleteParakeetModel,
  downloadParakeetModel,
  PARAKEET_DOWNLOAD_LABEL,
  parakeetModelAtom,
} from "../../../native/onDeviceTranscription";
import { isAppleTranscriptionAvailable } from "../../../native/voiceTranscription";
import { resolveVoiceTranscriptionEngine } from "../../../lib/voiceTranscriptionEngine";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";

/** Both engines run on the phone; Parakeet is downloaded on request instead of bundled. */
export function OnDeviceTranscriptionSettings() {
  const model = useAtomValue(parakeetModelAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  if (model.status === "unsupported") return null;

  const ready = AsyncResult.isSuccess(preferences);
  const preferred = ready ? preferences.value.voiceTranscriptionEngine : undefined;
  const appleAvailable = isAppleTranscriptionAvailable();
  const active = resolveVoiceTranscriptionEngine({
    preferred,
    appleAvailable,
    parakeetReady: model.status === "ready",
  });
  const choose = (engine: "apple" | "parakeet") => {
    savePreferences({ voiceTranscriptionEngine: engine });
    if (engine === "parakeet") void downloadParakeetModel();
  };

  return (
    <>
      <SettingsSection title="Transcription">
        <SettingsChoiceRow
          label="Apple"
          description={
            appleAvailable
              ? "Built into iOS. No download."
              : "Needs iOS 26 and a supported device language."
          }
          selected={active === "apple"}
          disabled={!ready || !appleAvailable}
          onPress={() => choose("apple")}
        />
        <SettingsChoiceRow
          label="Parakeet"
          description={`Runs on this iPhone in 25 languages. One-time download, ${PARAKEET_DOWNLOAD_LABEL}.`}
          selected={active === "parakeet" || (preferred === "parakeet" && active === null)}
          separated
          disabled={!ready}
          onPress={() => choose("parakeet")}
        />
        {model.status === "ready" ? (
          <SettingsActionRow
            icon="trash"
            label="Delete Parakeet model"
            tone="danger"
            onPress={() => void deleteParakeetModel()}
          />
        ) : (
          <SettingsActionRow
            icon="arrow.down.circle"
            label={
              model.status === "downloading"
                ? `Downloading Parakeet… ${Math.round(model.fraction * 100)}%`
                : `Download Parakeet (${PARAKEET_DOWNLOAD_LABEL})`
            }
            loading={model.status === "downloading"}
            disabled={model.status === "downloading"}
            onPress={() => void downloadParakeetModel()}
          />
        )}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {model.status === "failed"
          ? `Download failed: ${model.message}`
          : "Recordings never leave this iPhone with either engine. Deleting the model frees its storage; dictation then uses Apple where available."}
      </Text>
    </>
  );
}
