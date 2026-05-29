import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const appSettings = sqliteTable('app_settings', {
  id: integer('id').primaryKey(),
  defaultClaudeSessionSurface: text('default_claude_session_surface')
    .notNull()
    .default('claude-ui'),
  defaultAgentProvider: text('default_agent_provider')
    .notNull()
    .default('claude'),
  sessionToolbarButtons: text('session_toolbar_buttons'),
  onboardingCompletedAt: text('onboarding_completed_at'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
