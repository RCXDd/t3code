import {
  AuthSettingsWriteScope,
  isSpeechToTextConfigured,
  resolveSpeechToTextProviderSettings,
  SPEECH_TO_TEXT_PROVIDERS,
  type SpeechToTextCleanupMode,
  type SpeechToTextProvider,
  type SpeechToTextSettings,
  type SpeechToTextSettingsPatch,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

const PROVIDER_IDS = Object.keys(SPEECH_TO_TEXT_PROVIDERS) as SpeechToTextProvider[];

const CLEANUP_CHOICES: ReadonlyArray<{
  readonly mode: SpeechToTextCleanupMode | null;
  readonly label: string;
  readonly description: string;
}> = [
  { mode: null, label: "Off", description: "Insert the transcript as the service returned it." },
  {
    mode: "text-generation",
    label: "Text generation model",
    description: "Rewrite with the model chosen for commit messages and titles.",
  },
  {
    mode: "openai-compatible",
    label: "OpenAI-compatible",
    description: "Rewrite with a chat completions server such as Ollama or LM Studio.",
  },
];

export function SettingsSpeechToTextRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Speech to text" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <Text className="text-foreground-muted">Select a connected environment.</Text>
          ) : (
            selectedTargets.map((environment) => (
              <EnvironmentSpeechToText key={environment.environmentId} environment={environment} />
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

/**
 * Commits on end of editing, like the other text settings, so typing does not round-trip. The
 * field owns its draft while focused: a value another device saves only replaces it once the
 * field is idle. A secret field never shows the stored key and clears after each commit.
 */
function SettingsTextField(props: {
  readonly label: string;
  readonly description?: string;
  readonly value: string;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly secure?: boolean;
  readonly keyboardType?: "default" | "url";
  readonly onCommit: (value: string) => void;
}) {
  const initial = props.secure ? "" : props.value;
  const [draft, setDraft] = useState(initial);
  const [focused, setFocused] = useState(false);
  const [syncedValue, setSyncedValue] = useState(initial);
  if (!focused && initial !== syncedValue) {
    setSyncedValue(initial);
    setDraft(initial);
  }
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-sm text-foreground">{props.label}</Text>
      {props.description ? (
        <Text className="text-sm text-foreground-muted">{props.description}</Text>
      ) : null}
      <AppTextInput
        accessibilityLabel={props.label}
        value={draft}
        placeholder={props.placeholder}
        editable={!props.disabled}
        secureTextEntry={props.secure}
        keyboardType={props.keyboardType === "url" ? "url" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        onFocus={() => setFocused(true)}
        onChangeText={setDraft}
        onEndEditing={() => {
          setFocused(false);
          const value = draft.trim();
          if (props.secure) {
            // A stored key is replaced only by a new value; removing it is its own action.
            if (!props.disabled && value.length > 0) props.onCommit(value);
            setDraft("");
            return;
          }
          if (!props.disabled && value !== props.value) props.onCommit(value);
          setDraft(value);
        }}
      />
    </View>
  );
}

function EnvironmentSpeechToText({ environment }: { readonly environment: SettingsTarget }) {
  const settings: SpeechToTextSettings = environment.serverConfig.settings.speechToText;
  const supported = environment.serverConfig.environment.capabilities.speechToText === true;
  const canEdit = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const disabled = !supported || !canEdit;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const update = (speechToText: SpeechToTextSettingsPatch) =>
    void updateSettings({
      environmentId: environment.environmentId,
      input: { patch: { speechToText } },
    });

  const provider = settings.provider;
  const info = provider ? SPEECH_TO_TEXT_PROVIDERS[provider] : null;
  const configured = provider ? resolveSpeechToTextProviderSettings(settings, provider) : null;
  const keyStored = (configured?.apiKey.length ?? 0) > 0;
  const updateProvider = (fields: { model?: string; baseUrl?: string; apiKey?: string }) => {
    if (provider) update({ providers: { [provider]: fields } });
  };
  const cleanup = settings.cleanup;
  const cleanupKeyStored = cleanup.apiKey.length > 0;

  const status = !supported
    ? `Update ${environment.label} to use speech to text.`
    : !canEdit
      ? "This connection cannot change this environment's settings."
      : provider === null
        ? "Off. Dictation uses on-device transcription where the device supports it."
        : isSpeechToTextConfigured(settings)
          ? "Ready. Use the microphone in the composer to dictate."
          : info?.apiKeyRequired && !keyStored
            ? `Add your ${info.label} API key to finish setup.`
            : "Add the server URL and model to finish setup.";

  return (
    <>
      <SettingsSection title={environment.label} footer={status}>
        <SettingsChoiceRow
          label="Off"
          selected={provider === null}
          disabled={disabled}
          onPress={() => update({ provider: null })}
        />
        {PROVIDER_IDS.map((id) => (
          <SettingsChoiceRow
            key={id}
            label={SPEECH_TO_TEXT_PROVIDERS[id].label}
            selected={provider === id}
            separated
            disabled={disabled}
            onPress={() => update({ provider: id })}
          />
        ))}
      </SettingsSection>

      {provider && info && configured ? (
        <SettingsSection title={info.label}>
          <SettingsTextField
            key={`${provider}-api-key`}
            label="API key"
            description={
              info.apiKeyRequired
                ? "Stored in the environment's secret store and never sent back to devices."
                : "Optional. Sent as a bearer token when your server requires one."
            }
            value=""
            placeholder={keyStored ? "Stored. Enter a new key to replace it." : "Not set"}
            secure
            disabled={disabled}
            onCommit={(apiKey) => updateProvider({ apiKey })}
          />
          {keyStored ? (
            <SettingsActionRow
              icon="trash"
              label="Remove API key"
              tone="danger"
              disabled={disabled}
              onPress={() => updateProvider({ apiKey: "" })}
            />
          ) : null}
          {provider !== "xai" ? (
            <SettingsTextField
              key={`${provider}-model`}
              label="Model"
              description={
                info.suggestedModels.length > 0
                  ? `Leave empty for ${info.defaultModel}. Also: ${info.suggestedModels
                      .filter((model) => model !== info.defaultModel)
                      .join(", ")}.`
                  : "The model name your server expects."
              }
              value={configured.model}
              placeholder={info.defaultModel || "parakeet-tdt-0.6b-v3"}
              disabled={disabled}
              onCommit={(model) => updateProvider({ model })}
            />
          ) : null}
          <SettingsTextField
            key={`${provider}-base-url`}
            label="Server URL"
            description={
              info.defaultBaseUrl
                ? "Leave empty for the service's own endpoint."
                : "The /v1 address of a self-hosted Parakeet or Whisper server."
            }
            value={configured.baseUrl}
            placeholder={info.defaultBaseUrl || "http://127.0.0.1:5092/v1"}
            keyboardType="url"
            disabled={disabled}
            onCommit={(baseUrl) => updateProvider({ baseUrl })}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Dictation">
        <SettingsTextField
          label="Language"
          description="A code such as en or de. Leave empty to detect it from the recording."
          value={settings.language}
          placeholder="Auto-detect"
          disabled={disabled}
          onCommit={(language) => update({ language: language.toLowerCase() })}
        />
        {!info || info.supportsPrompt || cleanup.mode !== null ? (
          <SettingsTextField
            label="Vocabulary"
            description="Names and terms to spell correctly, separated by commas."
            value={settings.prompt}
            placeholder="T3 Code, TypeScript, Effect"
            disabled={disabled}
            onCommit={(prompt) => update({ prompt })}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Cleanup">
        {CLEANUP_CHOICES.map((choice, index) => (
          <SettingsChoiceRow
            key={choice.label}
            label={choice.label}
            description={choice.description}
            selected={cleanup.mode === choice.mode}
            separated={index > 0}
            disabled={disabled}
            onPress={() => update({ cleanup: { mode: choice.mode } })}
          />
        ))}
        {cleanup.mode === "openai-compatible" ? (
          <>
            <SettingsTextField
              label="Cleanup server URL"
              value={cleanup.baseUrl}
              placeholder="http://127.0.0.1:11434/v1"
              keyboardType="url"
              disabled={disabled}
              onCommit={(baseUrl) => update({ cleanup: { baseUrl } })}
            />
            <SettingsTextField
              label="Cleanup model"
              value={cleanup.model}
              placeholder="qwen3:4b"
              disabled={disabled}
              onCommit={(model) => update({ cleanup: { model } })}
            />
            <SettingsTextField
              label="Cleanup API key"
              description="Optional."
              value=""
              placeholder={cleanupKeyStored ? "Stored. Enter a new key to replace it." : "Not set"}
              secure
              disabled={disabled}
              onCommit={(apiKey) => update({ cleanup: { apiKey } })}
            />
            {cleanupKeyStored ? (
              <SettingsActionRow
                icon="trash"
                label="Remove cleanup API key"
                tone="danger"
                disabled={disabled}
                onPress={() => update({ cleanup: { apiKey: "" } })}
              />
            ) : null}
            <SettingsSwitchRow
              label="Use thread context"
              subtitle="Send the thread's last few messages so names match the conversation."
              value={cleanup.useThreadContext}
              disabled={disabled}
              onValueChange={(useThreadContext) => update({ cleanup: { useThreadContext } })}
            />
          </>
        ) : null}
        {cleanup.mode !== null ? (
          <SettingsTextField
            label="Instructions"
            value={cleanup.instructions}
            placeholder="Keep English technical terms"
            disabled={disabled}
            onCommit={(instructions) => update({ cleanup: { instructions } })}
          />
        ) : null}
      </SettingsSection>
    </>
  );
}
