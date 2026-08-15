export const DEFAULT_CLAUDE_SESSION_SURFACE = 'claude-ui';
export const DEFAULT_AGENT_PROVIDER = 'claude';

export const CLAUDE_SESSION_SURFACES = ['claude-ui', 'tui'] as const;

export const DEFAULT_AGENT_PROVIDERS = [
  'claude',
  'codex',
  'pi',
  'gemini',
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

export interface AppSettings {
  defaultClaudeSessionSurface: DefaultClaudeSessionSurface;
  defaultAgentProvider: DefaultAgentProvider;
  sessionToolbarButtons: SessionToolbarButtonSetting[] | null;
  defaultModelByProvider: AgentProviderPreferenceMap;
  defaultReasoningEffortByProvider: AgentProviderPreferenceMap;
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
}

export interface CompleteOnboardingInput {
  defaultAgentProvider: DefaultAgentProvider;
  defaultClaudeSessionSurface?: DefaultClaudeSessionSurface;
}
