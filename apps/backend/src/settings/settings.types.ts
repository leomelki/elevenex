export const DEFAULT_CLAUDE_SESSION_SURFACE = 'claude-ui';

export const CLAUDE_SESSION_SURFACES = [
  'claude-ui',
  'tui',
] as const;

export type DefaultClaudeSessionSurface =
  typeof CLAUDE_SESSION_SURFACES[number];

export interface AppSettings {
  defaultClaudeSessionSurface: DefaultClaudeSessionSurface;
  createdAt: string | null;
  updatedAt: string | null;
}
