export const DEFAULT_CLAUDE_SESSION_SURFACE = 'claude-ui';
export const DEFAULT_AGENT_PROVIDER = 'claude';

export const CLAUDE_SESSION_SURFACES = ['claude-ui', 'tui'] as const;

export const DEFAULT_AGENT_PROVIDERS = ['claude', 'codex', 'pi'] as const;

export type DefaultClaudeSessionSurface =
  (typeof CLAUDE_SESSION_SURFACES)[number];
export type DefaultAgentProvider = (typeof DEFAULT_AGENT_PROVIDERS)[number];

export interface SessionToolbarButtonSetting {
  id: string;
  visible: boolean;
}

export interface AppSettings {
  defaultClaudeSessionSurface: DefaultClaudeSessionSurface;
  defaultAgentProvider: DefaultAgentProvider;
  sessionToolbarButtons: SessionToolbarButtonSetting[] | null;
  onboardingCompletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface UpdateAppSettingsInput {
  defaultClaudeSessionSurface?: DefaultClaudeSessionSurface;
  defaultAgentProvider?: DefaultAgentProvider;
  sessionToolbarButtons?: SessionToolbarButtonSetting[] | null;
}

export interface CompleteOnboardingInput {
  defaultAgentProvider: DefaultAgentProvider;
  defaultClaudeSessionSurface?: DefaultClaudeSessionSurface;
}
