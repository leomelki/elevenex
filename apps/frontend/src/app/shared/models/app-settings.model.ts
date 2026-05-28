export type DefaultClaudeSessionSurface = 'claude-ui' | 'tui';

export interface AppSettings {
  defaultClaudeSessionSurface: DefaultClaudeSessionSurface;
  createdAt: string | null;
  updatedAt: string | null;
}
