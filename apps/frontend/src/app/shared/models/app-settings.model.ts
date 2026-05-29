import { SessionToolbarButtonPreference } from './session-toolbar-button.model';

export type DefaultClaudeSessionSurface = 'claude-ui' | 'tui';

export interface AppSettings {
  defaultClaudeSessionSurface: DefaultClaudeSessionSurface;
  sessionToolbarButtons: SessionToolbarButtonPreference[] | null;
  createdAt: string | null;
  updatedAt: string | null;
}
