import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  isSpeechToTextConfigured,
  resolveSpeechToTextProviderSettings,
  SPEECH_TO_TEXT_PROVIDERS,
  SpeechToTextProvider,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const OFF = "off";
const isProvider = Schema.is(SpeechToTextProvider);
const PROVIDER_IDS = Object.keys(SPEECH_TO_TEXT_PROVIDERS) as SpeechToTextProvider[];

export function SpeechToTextSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up speech to text.`
          : "Connect an environment to set up speech to text."}
      </p>
    );
  }
  return (
    <SpeechToTextForm
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      supported={environment.serverConfig?.environment.capabilities.speechToText === true}
    />
  );
}

function SpeechToTextForm(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly supported: boolean;
}) {
  const settings = useEnvironmentSettings(props.environmentId, (value) => value.speechToText);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const canEdit = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const disabled = !canEdit || !props.supported;
  const provider = settings.provider;
  const info = provider ? SPEECH_TO_TEXT_PROVIDERS[provider] : null;
  const configured = provider ? resolveSpeechToTextProviderSettings(settings, provider) : null;
  const keyStored = (configured?.apiKey.length ?? 0) > 0;

  const updateProvider = (fields: { model?: string; baseUrl?: string; apiKey?: string }) => {
    if (!provider) return;
    updateSettings({ speechToText: { providers: { [provider]: fields } } });
  };

  const status = !props.supported
    ? `Update ${props.environmentLabel} to use speech to text.`
    : !canEdit
      ? `This connection cannot change settings on ${props.environmentLabel}.`
      : provider === null
        ? "Off. On iPhone, dictation keeps using on-device transcription."
        : isSpeechToTextConfigured(settings)
          ? "Ready. Use the microphone in the composer to dictate."
          : info?.apiKeyRequired && !keyStored
            ? `Add your ${info.label} API key to finish setup.`
            : "Add the server URL and model to finish setup.";

  return (
    <SettingsPageContainer>
      <SettingsSection title="Speech to text" id="speech-to-text">
        <SettingsRow
          {...searchableSetting("speech-to-text-provider")}
          description={
            <>
              Dictate into the composer on every device connected to {props.environmentLabel}.
              Recordings are sent from this environment to the service you choose. {status}
            </>
          }
          control={
            <Select
              value={provider ?? OFF}
              disabled={disabled}
              onValueChange={(value) => {
                if (value === OFF) updateSettings({ speechToText: { provider: null } });
                else if (isProvider(value)) updateSettings({ speechToText: { provider: value } });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-64"
                aria-label="Transcription service"
              >
                <SelectValue>{info?.label ?? "Off"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={OFF}>
                  Off
                </SelectItem>
                {PROVIDER_IDS.map((id) => (
                  <SelectItem key={id} hideIndicator value={id}>
                    {SPEECH_TO_TEXT_PROVIDERS[id].label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        {provider && info && configured ? (
          <>
            <SettingsRow
              key={`${provider}-key`}
              {...searchableSetting("speech-to-text-api-key")}
              description={
                <>
                  {info.apiKeyRequired
                    ? "Stored in this environment's secret store and never sent back to clients."
                    : "Optional. Sent as a bearer token when your server requires one."}
                  {info.apiKeyUrl ? (
                    <>
                      {" "}
                      <a
                        href={info.apiKeyUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        Create a key
                      </a>
                    </>
                  ) : null}
                </>
              }
              control={
                <div className="flex w-full items-center gap-1 sm:w-64">
                  <SecretInput
                    size="sm"
                    configured={keyStored}
                    value=""
                    disabled={disabled}
                    aria-label={`${info.label} API key`}
                    onCommit={(apiKey) => updateProvider({ apiKey })}
                  />
                  {keyStored ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled}
                      aria-label="Remove API key"
                      onClick={() => updateProvider({ apiKey: "" })}
                    >
                      <XIcon />
                    </Button>
                  ) : null}
                </div>
              }
            />
            {provider !== "xai" ? (
              <SettingsRow
                key={`${provider}-model`}
                {...searchableSetting("speech-to-text-model")}
                description={
                  info.suggestedModels.length > 0
                    ? `Leave empty for ${info.defaultModel}. Also available: ${info.suggestedModels
                        .filter((model) => model !== info.defaultModel)
                        .join(", ")}.`
                    : "The model name your server expects."
                }
                control={
                  <DraftInput
                    size="sm"
                    className="w-full sm:w-64"
                    list={`speech-to-text-models-${provider}`}
                    placeholder={info.defaultModel || "parakeet-tdt-0.6b-v3"}
                    value={configured.model}
                    disabled={disabled}
                    aria-label="Transcription model"
                    onCommit={(model) => updateProvider({ model: model.trim() })}
                  />
                }
              >
                <datalist id={`speech-to-text-models-${provider}`}>
                  {info.suggestedModels.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </SettingsRow>
            ) : null}
            <SettingsRow
              key={`${provider}-url`}
              {...searchableSetting("speech-to-text-base-url")}
              description={
                info.defaultBaseUrl
                  ? "Leave empty for the service's own endpoint."
                  : "The /v1 address of a self-hosted Parakeet or Whisper server."
              }
              control={
                <DraftInput
                  size="sm"
                  type="url"
                  className="w-full sm:w-64"
                  placeholder={info.defaultBaseUrl || "http://127.0.0.1:5092/v1"}
                  value={configured.baseUrl}
                  disabled={disabled}
                  aria-label="Transcription server URL"
                  onCommit={(baseUrl) => updateProvider({ baseUrl: baseUrl.trim() })}
                />
              }
            />
          </>
        ) : null}

        <SettingsRow
          {...searchableSetting("speech-to-text-language")}
          description="Language code such as en or de. Leave empty to detect it from the recording."
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-64"
              placeholder="Auto-detect"
              value={settings.language}
              disabled={disabled}
              aria-label="Dictation language"
              onCommit={(language) =>
                updateSettings({ speechToText: { language: language.trim().toLowerCase() } })
              }
            />
          }
        />
        {!info || info.supportsPrompt ? (
          <SettingsRow
            {...searchableSetting("speech-to-text-prompt")}
            description="Names and terms the service should spell correctly, separated by commas."
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-64"
                placeholder="T3 Code, TypeScript, Effect"
                value={settings.prompt}
                disabled={disabled}
                aria-label="Dictation vocabulary"
                onCommit={(prompt) => updateSettings({ speechToText: { prompt: prompt.trim() } })}
              />
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
