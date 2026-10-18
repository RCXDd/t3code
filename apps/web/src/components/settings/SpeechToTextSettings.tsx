import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  isSpeechToTextConfigured,
  resolveSpeechToTextProviderSettings,
  SPEECH_TO_TEXT_PROVIDERS,
  SpeechToTextCleanupMode,
  SpeechToTextProvider,
  type SpeechToTextSettings,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
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
  const textModel = useEnvironmentSettings(
    props.environmentId,
    (value) => value.textGenerationModelSelection.model,
  );
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
        {!info || info.supportsPrompt || settings.cleanup.mode !== null ? (
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
      <DictationCleanupSection
        settings={settings}
        disabled={disabled}
        textModel={textModel}
        updateCleanup={(cleanup) => updateSettings({ speechToText: { cleanup } })}
      />
    </SettingsPageContainer>
  );
}

const CLEANUP_MODE_LABELS = {
  off: "Off",
  "text-generation": "Text generation model",
  "openai-compatible": "OpenAI-compatible (Ollama, LM Studio)",
} as const;
const isCleanupMode = Schema.is(SpeechToTextCleanupMode);

function DictationCleanupSection(props: {
  readonly settings: SpeechToTextSettings;
  readonly disabled: boolean;
  readonly textModel: string;
  readonly updateCleanup: (cleanup: {
    mode?: SpeechToTextCleanupMode | null;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    instructions?: string;
    useThreadContext?: boolean;
  }) => void;
}) {
  const cleanup = props.settings.cleanup;
  const keyStored = cleanup.apiKey.length > 0;
  return (
    <SettingsSection title="Cleanup" id="speech-to-text-cleanup">
      <SettingsRow
        {...searchableSetting("speech-to-text-cleanup")}
        description={
          cleanup.mode === "text-generation"
            ? `Rewrites each transcript with ${props.textModel}, the text generation model in Settings → Providers, before it is inserted.`
            : "Removes filler words, fixes grammar, and spells names the way your conversation does before the transcript is inserted. Adds a few seconds per dictation."
        }
        control={
          <Select
            value={cleanup.mode ?? "off"}
            disabled={props.disabled}
            onValueChange={(value) => {
              if (value === "off") props.updateCleanup({ mode: null });
              else if (isCleanupMode(value)) props.updateCleanup({ mode: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-64" aria-label="Dictation cleanup">
              <SelectValue>{CLEANUP_MODE_LABELS[cleanup.mode ?? "off"]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(CLEANUP_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {cleanup.mode === "openai-compatible" ? (
        <>
          <SettingsRow
            {...searchableSetting("speech-to-text-cleanup-base-url")}
            description="The /v1 address of a chat completions server. Ollama listens on port 11434."
            control={
              <DraftInput
                size="sm"
                type="url"
                className="w-full sm:w-64"
                placeholder="http://127.0.0.1:11434/v1"
                value={cleanup.baseUrl}
                disabled={props.disabled}
                aria-label="Cleanup server URL"
                onCommit={(baseUrl) => props.updateCleanup({ baseUrl: baseUrl.trim() })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("speech-to-text-cleanup-model")}
            description="A small instruction model is enough, such as qwen3:4b or gemma3:4b."
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-64"
                placeholder="qwen3:4b"
                value={cleanup.model}
                disabled={props.disabled}
                aria-label="Cleanup model"
                onCommit={(model) => props.updateCleanup({ model: model.trim() })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("speech-to-text-cleanup-api-key")}
            description="Optional. Sent as a bearer token when your server requires one."
            control={
              <div className="flex w-full items-center gap-1 sm:w-64">
                <SecretInput
                  size="sm"
                  configured={keyStored}
                  value=""
                  disabled={props.disabled}
                  aria-label="Cleanup API key"
                  onCommit={(apiKey) => props.updateCleanup({ apiKey })}
                />
                {keyStored ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={props.disabled}
                    aria-label="Remove cleanup API key"
                    onClick={() => props.updateCleanup({ apiKey: "" })}
                  >
                    <XIcon />
                  </Button>
                ) : null}
              </div>
            }
          />
        </>
      ) : null}
      {cleanup.mode !== null ? (
        <>
          <SettingsRow
            {...searchableSetting("speech-to-text-cleanup-instructions")}
            description="Extra rules for the rewrite, such as tone or formatting."
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-64"
                placeholder="Keep English technical terms"
                value={cleanup.instructions}
                disabled={props.disabled}
                aria-label="Cleanup instructions"
                onCommit={(instructions) =>
                  props.updateCleanup({ instructions: instructions.trim() })
                }
              />
            }
          />
          <SettingsRow
            {...searchableSetting("speech-to-text-cleanup-context")}
            description="Sends the thread's last few messages with the transcript so names, files, and terms match the conversation."
            control={
              <Switch
                checked={cleanup.useThreadContext}
                disabled={props.disabled}
                onCheckedChange={(checked) =>
                  props.updateCleanup({ useThreadContext: Boolean(checked) })
                }
                aria-label="Use thread context"
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
