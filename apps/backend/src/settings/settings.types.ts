export const DEFAULT_CLAUDE_SESSION_SURFACE = 'claude-ui';
export const DEFAULT_AGENT_PROVIDER = 'claude';

export const CLAUDE_SESSION_SURFACES = ['claude-ui', 'tui'] as const;

export const DEFAULT_AGENT_PROVIDERS = [
  'claude',
  'codex',
  'pi',
  'antigravity',
] as const;

export type DefaultClaudeSessionSurface =
  (typeof CLAUDE_SESSION_SURFACES)[number];
export type DefaultAgentProvider = (typeof DEFAULT_AGENT_PROVIDERS)[number];

export interface SessionToolbarButtonSetting {
  id: string;
  visible: boolean;
}

/**
 * Per-provider preference maps (`{"claude":"opus","codex":"gpt-5.5"}`). Keys are
 * agent provider ids and values are opaque provider-defined identifiers, so a
 * newly released model — or a provider we don't know about yet — is storable
 * without a migration or a code change. A missing key means "defer to whatever
 * the provider itself defaults to".
 */
export type AgentProviderPreferenceMap = Record<string, string>;

/**
 * Patch shape for the maps above. A `null` value clears that provider's entry;
 * omitted providers keep their current value, so two clients editing different
 * providers can't clobber each other.
 */
export type AgentProviderPreferencePatch = Record<string, string | null>;

/** Resolved startup defaults for one provider. */
export interface AgentProviderDefaults {
  model: string | null;
  reasoningEffort: string | null;
}

/** Keys must look like provider ids; values are provider-defined identifiers. */
export const AGENT_PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const MAX_AGENT_PREFERENCE_VALUE_LENGTH = 200;
export const MAX_AGENT_PREFERENCE_ENTRIES = 32;

export const SPEECH_TO_TEXT_PROVIDERS = [
  'elevenlabs',
  'openai-compatible',
  'openrouter',
] as const;
export type SpeechToTextProviderId = (typeof SPEECH_TO_TEXT_PROVIDERS)[number];

/**
 * How the raw transcript is cleaned up before it reaches the textarea.
 * - `off`: insert exactly what the STT provider returned.
 * - `session-harness`: reuse the agent provider the current session is running
 *   on, with that provider's configured default model.
 * - `fixed`: an explicit provider + model the user pinned in settings.
 */
export const SPEECH_CLEANUP_MODES = ['off', 'session-harness', 'fixed'] as const;
export type SpeechCleanupMode = (typeof SPEECH_CLEANUP_MODES)[number];

export interface SpeechToTextSettings {
  enabled: boolean;
  provider: SpeechToTextProviderId;
  /** Only meaningful for `openai-compatible`; `null` means api.openai.com. */
  baseUrl: string | null;
  /** `null` means "use this provider's default model". */
  model: string | null;
  /** ISO-639 code, or `null` to let the provider auto-detect. */
  language: string | null;
  /** Bias transcription towards repo/branch/file names. */
  keytermsEnabled: boolean;
  cleanupMode: SpeechCleanupMode;
  /** Only read when `cleanupMode` is `fixed`. */
  cleanupProvider: DefaultAgentProvider | null;
  cleanupModel: string | null;
  /** Submit the composer automatically once a transcript lands. */
  autoSend: boolean;
  /** Stop recording after a short pause instead of waiting for a click. */
  silenceAutoStop: boolean;
}

export const DEFAULT_SPEECH_TO_TEXT_SETTINGS: SpeechToTextSettings = {
  enabled: false,
  provider: 'elevenlabs',
  baseUrl: null,
  model: null,
  language: null,
  keytermsEnabled: true,
  cleanupMode: 'off',
  cleanupProvider: null,
  cleanupModel: null,
  autoSend: false,
  silenceAutoStop: true,
};

/** Used when `SpeechToTextSettings.model` is `null`. */
export const DEFAULT_SPEECH_TO_TEXT_MODELS: Record<
  SpeechToTextProviderId,
  string
> = {
  elevenlabs: 'scribe_v2',
  'openai-compatible': 'gpt-4o-transcribe',
  openrouter: 'google/gemini-2.5-flash',
};

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1';

export const MAX_SPEECH_SETTING_VALUE_LENGTH = 400;

export interface AppSettings {
  defaultClaudeSessionSurface: DefaultClaudeSessionSurface;
  defaultAgentProvider: DefaultAgentProvider;
  sessionToolbarButtons: SessionToolbarButtonSetting[] | null;
  defaultModelByProvider: AgentProviderPreferenceMap;
  defaultReasoningEffortByProvider: AgentProviderPreferenceMap;
  speechToText: SpeechToTextSettings;
  /**
   * Whether a dictation key is available (from the database or the
   * environment). The key itself is never returned by the API.
   */
  speechToTextApiKeyConfigured: boolean;
  /** True when the key comes from the environment, so the UI can say it is not editable here. */
  speechToTextApiKeyFromEnv: boolean;
  onboardingCompletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface UpdateAppSettingsInput {
  defaultClaudeSessionSurface?: DefaultClaudeSessionSurface;
  defaultAgentProvider?: DefaultAgentProvider;
  sessionToolbarButtons?: SessionToolbarButtonSetting[] | null;
  defaultModelByProvider?: AgentProviderPreferencePatch | null;
  defaultReasoningEffortByProvider?: AgentProviderPreferencePatch | null;
  /** Partial patch; omitted keys keep their stored value. */
  speechToText?: Partial<SpeechToTextSettings> | null;
  /** `undefined` keeps the stored key, `null`/`''` clears it. */
  speechToTextApiKey?: string | null;
}

export interface CompleteOnboardingInput {
  defaultAgentProvider: DefaultAgentProvider;
  defaultClaudeSessionSurface?: DefaultClaudeSessionSurface;
}
