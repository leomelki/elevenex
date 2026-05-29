import { SessionToolbarButtonPreference } from './session-toolbar-button.model';

export type DefaultClaudeSessionSurface = 'claude-ui' | 'tui';
export type DefaultAgentProvider = 'claude' | 'codex' | 'pi';

export interface AppSettings {
  defaultClaudeSessionSurface: DefaultClaudeSessionSurface;
  defaultAgentProvider: DefaultAgentProvider;
  sessionToolbarButtons: SessionToolbarButtonPreference[] | null;
  onboardingCompletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
