import { integer, text, sqliteTable } from 'drizzle-orm/sqlite-core';
import { repos } from './repos.schema.js';
import { workspaces } from './workspaces.schema.js';

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoId: integer('repo_id')
    .notNull()
    .references(() => repos.id, { onDelete: 'cascade' }),
  workspaceId: integer('workspace_id').references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  branchName: text('branch_name').notNull(),
  worktreePath: text('worktree_path').notNull(),
  name: text('name'),
  surface: text('surface').notNull().default('session'),
  status: text('status').notNull().default('created'),
  // Bearer token minted for "agent" sessions (the meta-agent that operates
  // elevenex). Injected as ELEVENEX_AGENT_TOKEN into the inner process env and
  // presented by the Elevenex MCP server to resolve this session's identity so
  // human-channel tools route to its panel. Null for ordinary coding sessions.
  mcpAgentToken: text('mcp_agent_token'),
  // Autonomy mandate for "agent" sessions: 'full' | 'review' | 'plan'. Controls
  // the permission policy the runtime enforces (auto-allow vs. ask vs. plan-mode)
  // and which autonomy clause is substituted into the meta-agent system prompt.
  // Null for ordinary coding sessions; defaults to 'review' when read.
  agentAutonomyMode: text('agent_autonomy_mode'),
  activeAgentProvider: text('active_agent_provider')
    .notNull()
    .default('claude'),
  claudeSessionId: text('claude_session_id').default('-1'),
  codexSessionId: text('codex_session_id').default('-1'),
  piSessionPath: text('pi_session_path').default('-1'),
  antigravitySessionId: text('antigravity_session_id').default('-1'),
  hasInjectedWorktreeContext: integer('has_injected_worktree_context', {
    mode: 'boolean',
  })
    .notNull()
    .default(false),
  hasUnreviewedCompletion: integer('has_unreviewed_completion', {
    mode: 'boolean',
  })
    .notNull()
    .default(false),
  lastCompletionAt: text('last_completion_at'),
  lastCompletionKind: text('last_completion_kind'),
  lastStateChangeAt: text('last_state_change_at'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
