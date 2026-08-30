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
  // Non-secret dictation config as a single JSON object, for the same reason as
  // the maps above: adding a knob or a new STT provider needs no migration.
  speechToText: text('speech_to_text'),
  /**
   * Dictation API key. Deliberately its own column and never merged into the
   * JSON above: `SettingsService.toResponse()` builds the API payload from
   * `speechToText` alone, so the secret cannot leak into `GET /api/settings`
   * by someone later adding a field to the config object.
   */
  speechToTextApiKey: text('speech_to_text_api_key'),
  onboardingCompletedAt: text('onboarding_completed_at'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
