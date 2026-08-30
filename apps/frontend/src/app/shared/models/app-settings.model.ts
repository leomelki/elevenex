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
  'local-whisper',
  'elevenlabs',
  'openai-compatible',
  'openrouter',
] as const;
export type SpeechToTextProviderId = (typeof SPEECH_TO_TEXT_PROVIDERS)[number];

/** Providers that transcribe on this machine and so need no API key. */
export const OFFLINE_SPEECH_TO_TEXT_PROVIDERS: readonly SpeechToTextProviderId[] =
  ['local-whisper'];

/** Mirrors `LOCAL_WHISPER_MODELS` on the backend. */
export const LOCAL_WHISPER_MODELS = [
  'tiny',
  'base',
  'small',
  'large-v3-turbo',
] as const;
export type LocalWhisperModelId = (typeof LOCAL_WHISPER_MODELS)[number];

export const DEFAULT_LOCAL_WHISPER_MODEL: LocalWhisperModelId = 'small';

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
  /** Which Whisper build `local-whisper` runs; kept when switching providers. */
  localModel: LocalWhisperModelId;
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
  provider: 'local-whisper',
  baseUrl: null,
  localModel: DEFAULT_LOCAL_WHISPER_MODEL,
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
 * Providers that cannot accept the browser's native recording, so the client
 * transcodes to WAV first.
 *
 * - `openrouter` takes audio as a chat `input_audio` part whose documented
 *   formats exclude webm, which is exactly what `MediaRecorder` produces.
 * - `local-whisper` needs raw PCM samples, and the only decoder guaranteed to
 *   understand the codec the browser just recorded is that same browser's —
 *   so it decodes here rather than shipping a codec library to the backend.
 */
export const SPEECH_PROVIDERS_REQUIRING_WAV: readonly SpeechToTextProviderId[] =
  ['openrouter', 'local-whisper'];

export interface AppSettings {
  defaultClaudeSessionSurface: DefaultClaudeSessionSurface;
  defaultAgentProvider: DefaultAgentProvider;
  sessionToolbarButtons: SessionToolbarButtonPreference[] | null;
  defaultModelByProvider: AgentProviderPreferenceMap;
  defaultReasoningEffortByProvider: AgentProviderPreferenceMap;
  speechToText: SpeechToTextSettings;
  speechToTextApiKeyConfigured: boolean;
  speechToTextApiKeyFromEnv: boolean;
  /** False for offline providers, whose readiness is a downloaded model. */
  speechToTextRequiresApiKey: boolean;
  onboardingCompletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
