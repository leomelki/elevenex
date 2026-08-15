import { SessionToolbarButtonPreference } from './session-toolbar-button.model';

export type DefaultClaudeSessionSurface = 'claude-ui' | 'tui';
export type DefaultAgentProvider = 'claude' | 'codex' | 'pi' | 'gemini';

/**
 * Per-provider preferences keyed by agent provider id. Values are opaque
 * provider-defined identifiers, so a model released tomorrow is storable
 * without a frontend change. A missing key means "use the provider's default".
 */
export type AgentProviderPreferenceMap = Record<string, string>;

export interface AppSettings {
  defaultClaudeSessionSurface: DefaultClaudeSessionSurface;
  defaultAgentProvider: DefaultAgentProvider;
  sessionToolbarButtons: SessionToolbarButtonPreference[] | null;
  defaultModelByProvider: AgentProviderPreferenceMap;
  defaultReasoningEffortByProvider: AgentProviderPreferenceMap;
  onboardingCompletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
