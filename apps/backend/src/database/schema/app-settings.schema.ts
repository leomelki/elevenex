import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const appSettings = sqliteTable('app_settings', {
  id: integer('id').primaryKey(),
  defaultClaudeSessionSurface: text('default_claude_session_surface')
    .notNull()
    .default('claude-ui'),
  defaultAgentProvider: text('default_agent_provider')
    .notNull()
    .default('claude'),
  // JSON objects keyed by agent provider id (`{"claude":"opus"}`), so a newly
  // supported provider needs no schema change.
  defaultModelByProvider: text('default_model_by_provider'),
  defaultReasoningEffortByProvider: text('default_reasoning_effort_by_provider'),
  sessionToolbarButtons: text('session_toolbar_buttons'),
  onboardingCompletedAt: text('onboarding_completed_at'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
