import { SessionToolbarButtonPreference } from './session-toolbar-button.model';

export type DefaultClaudeSessionSurface = 'claude-ui' | 'tui';
export type DefaultAgentProvider = 'claude' | 'codex' | 'pi' | 'antigravity';

/**
 * Per-provider preferences keyed by agent provider id. Values are opaque
 * provider-defined identifiers, so a model released tomorrow is storable
 * without a frontend change. A missing key means "use the provider's default".
 */
export type AgentProviderPreferenceMap = Record<string, string>;

export const SPEECH_TO_TEXT_PROVIDERS = [
  'elevenlabs',
  'openai-compatible',
  'openrouter',
] as const;
export type SpeechToTextProviderId = (typeof SPEECH_TO_TEXT_PROVIDERS)[number];

export const SPEECH_CLEANUP_MODES = ['off', 'session-harness', 'fixed'] as const;
export type SpeechCleanupMode = (typeof SPEECH_CLEANUP_MODES)[number];

/**
 * Dictation settings. Mirrors `SpeechToTextSettings` on the backend; the API
 * key is deliberately absent — the server only ever reports whether one is
 * configured.
 */
export interface SpeechToTextSettings {
  enabled: boolean;
  provider: SpeechToTextProviderId;
  baseUrl: string | null;
  model: string | null;
  language: string | null;
  keytermsEnabled: boolean;
  cleanupMode: SpeechCleanupMode;
  cleanupProvider: DefaultAgentProvider | null;
  cleanupModel: string | null;
  autoSend: boolean;
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

/**
 * Providers that cannot accept the browser's native recording. OpenRouter takes
 * audio as a chat `input_audio` part whose documented formats exclude webm, so
 * the client transcodes to WAV for it — and only for it.
 */
export const SPEECH_PROVIDERS_REQUIRING_WAV: readonly SpeechToTextProviderId[] =
  ['openrouter'];

export interface AppSettings {
  defaultClaudeSessionSurface: DefaultClaudeSessionSurface;
  defaultAgentProvider: DefaultAgentProvider;
  sessionToolbarButtons: SessionToolbarButtonPreference[] | null;
  defaultModelByProvider: AgentProviderPreferenceMap;
  defaultReasoningEffortByProvider: AgentProviderPreferenceMap;
  speechToText: SpeechToTextSettings;
  speechToTextApiKeyConfigured: boolean;
  speechToTextApiKeyFromEnv: boolean;
  onboardingCompletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
