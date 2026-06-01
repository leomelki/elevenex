import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import { AGENT_RUNTIME_CLEANUP_SERVICE } from '../agent-runtime/agent-runtime.tokens.js';
import { PtyManager } from '../terminal/pty-manager.service.js';
import { TmuxManager } from '../terminal/tmux-manager.service.js';
import { PlanChatForksService } from './plan-chat-forks.service.js';
import { SessionsService } from './sessions.service.js';
import { SettingsService } from '../settings/settings.service.js';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      color TEXT,
      preferred_context_root_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, path)
    );
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_from_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_id, name),
      UNIQUE(repo_id, path)
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      branch_name TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      name TEXT,
      surface TEXT NOT NULL DEFAULT 'session',
      status TEXT NOT NULL DEFAULT 'created',
      active_agent_provider TEXT NOT NULL DEFAULT 'claude',
      claude_session_id TEXT DEFAULT '-1',
      codex_session_id TEXT DEFAULT '-1',
      pi_session_path TEXT DEFAULT '-1',
      has_injected_worktree_context INTEGER NOT NULL DEFAULT 0,
      has_unreviewed_completion INTEGER NOT NULL DEFAULT 0,
      last_completion_at TEXT,
      last_completion_kind TEXT,
      last_state_change_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE plan_chat_forks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      child_session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      review_id TEXT NOT NULL,
      anchor_message_id TEXT NOT NULL,
      anchor_message_kind TEXT NOT NULL,
      anchor_excerpt TEXT,
      plan_excerpt TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(parent_session_id, review_id)
    );
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe('PlanChatForksService', () => {
  let sessionsService: SessionsService;
  let planChatsService: PlanChatForksService;
  let db: BetterSQLite3Database<typeof schema>;
  let sqliteConn: InstanceType<typeof Database>;
  let repoId: number;
  let provider: {
    forkConversation: jest.Mock;
    setPlanMode: jest.Mock;
    submitPrompt: jest.Mock;
  };
  let agentRuntimeCleanup: { cleanupSession: jest.Mock };
  let settingsService: { findOne: jest.Mock };

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    sqliteConn = testDb.sqlite;

    const projectRows = await db
      .insert(schema.projects)
      .values({ name: 'Test Project' })
      .returning();
    const repoRows = await db
      .insert(schema.repos)
      .values({
        projectId: projectRows[0].id,
        name: 'test-repo',
        path: '/tmp/test-repo',
      })
      .returning();
    repoId = repoRows[0].id;

    provider = {
      forkConversation: jest.fn(),
      setPlanMode: jest.fn().mockResolvedValue({}),
      submitPrompt: jest.fn().mockResolvedValue(undefined),
    };
    agentRuntimeCleanup = {
      cleanupSession: jest.fn().mockResolvedValue(undefined),
    };
    settingsService = {
      findOne: jest.fn().mockResolvedValue({
        defaultClaudeSessionSurface: 'claude-ui',
        defaultAgentProvider: 'claude',
        sessionToolbarButtons: null,
        onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
        createdAt: null,
        updatedAt: null,
      }),
    };

    const registry = {
      getProviderFeature: jest.fn(() => provider),
      getProvider: jest.fn(() => provider),
    };
    const moduleRef = {
      get: jest.fn((token) =>
        token === AgentRuntimeRegistryService ? registry : null,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionsService,
        PlanChatForksService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: PtyManager,
          useValue: {
            kill: jest.fn(),
            killTmuxSession: jest.fn(),
          },
        },
        {
          provide: TmuxManager,
          useValue: {
            isTmuxAvailable: jest.fn(() => false),
            sessionExists: jest.fn(),
            killSession: jest.fn(),
          },
        },
        {
          provide: AGENT_RUNTIME_CLEANUP_SERVICE,
          useValue: agentRuntimeCleanup,
        },
        { provide: SettingsService, useValue: settingsService },
        { provide: ModuleRef, useValue: moduleRef },
      ],
    }).compile();

    sessionsService = module.get(SessionsService);
    planChatsService = module.get(PlanChatForksService);
  });

  afterEach(() => {
    sqliteConn.close();
  });

  async function createParent() {
    const parent = await sessionsService.create({
      repoId,
      branchName: 'main',
      worktreePath: '/tmp/worktree',
      name: 'Parent',
    });
    await sessionsService.updateClaudeSessionId(parent.id, 'claude-parent');
    return sessionsService.findOne(parent.id);
  }

  it('creates and reuses hidden plan chat forks by review id', async () => {
    const parent = await createParent();
    provider.forkConversation.mockResolvedValue({
      providerSessionId: 'claude-plan-chat',
      anchorExcerpt: '# Plan',
    });

    const first = await planChatsService.ensure(parent.id, {
      reviewId: 'tagged-plan:message-1',
      anchorMessageId: 'assistant-1',
      anchorMessageKind: 'assistant',
      planMarkdown: '# Plan\n\nDo it',
    });
    const second = await planChatsService.ensure(parent.id, {
      reviewId: 'tagged-plan:message-1',
      anchorMessageId: 'assistant-1',
      anchorMessageKind: 'assistant',
      planMarkdown: '# Plan\n\nDo it',
    });

    expect(second.planChat.id).toBe(first.planChat.id);
    expect(provider.forkConversation).toHaveBeenCalledTimes(1);
    expect(provider.setPlanMode).toHaveBeenCalledWith(first.session.id, true);

    const visibleSessions = await sessionsService.findByRepo(repoId);
    const allSessions = await sessionsService.findByRepo(repoId, {
      includeHidden: true,
    });
    expect(visibleSessions.map((session) => session.id)).toEqual([parent.id]);
    expect(allSessions.map((session) => session.id).sort()).toEqual(
      [parent.id, first.session.id].sort(),
    );
    expect(first.session.surface).toBe('embedded_plan_chat');
  });

  it('submits questions with a guarded prompt and raw title prompt', async () => {
    const parent = await createParent();
    provider.forkConversation.mockResolvedValue({
      providerSessionId: 'claude-plan-chat',
      anchorExcerpt: '# Plan',
    });
    const { planChat, session } = await planChatsService.ensure(parent.id, {
      reviewId: 'review-1',
      anchorMessageId: 'assistant-1',
      anchorMessageKind: 'assistant',
      planMarkdown: '# Plan\n\nDo it',
    });

    await planChatsService.submitQuestion(parent.id, planChat.id, {
      question: 'Why this order?',
    });

    expect(provider.submitPrompt).toHaveBeenCalledTimes(1);
    const [sessionId, prompt, titlePrompt] =
      provider.submitPrompt.mock.calls[0];
    expect(sessionId).toBe(session.id);
    expect(titlePrompt).toBe('Why this order?');
    expect(prompt).toContain('hidden Q&A fork');
    expect(prompt).toContain(
      '<elevenex_plan_question>\nWhy this order?\n</elevenex_plan_question>',
    );
    expect(prompt).toContain('Do not write a new plan');
  });

  it('returns immediately after dispatching a plan chat question', async () => {
    const parent = await createParent();
    provider.forkConversation.mockResolvedValue({
      providerSessionId: 'claude-plan-chat',
      anchorExcerpt: '# Plan',
    });
    const { planChat } = await planChatsService.ensure(parent.id, {
      reviewId: 'review-1',
      anchorMessageId: 'assistant-1',
      anchorMessageKind: 'assistant',
      planMarkdown: '# Plan',
    });

    let resolvePrompt!: () => void;
    provider.submitPrompt.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      }),
    );

    await expect(
      planChatsService.submitQuestion(parent.id, planChat.id, {
        question: 'Can I ask while you answer?',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        question: 'Can I ask while you answer?',
      }),
    );

    expect(provider.submitPrompt).toHaveBeenCalledTimes(1);
    resolvePrompt();
  });

  it('creates hidden plan chat forks for pending exit-plan reviews without a transcript anchor', async () => {
    const parent = await createParent();
    provider.forkConversation.mockResolvedValue({
      providerSessionId: 'claude-plan-chat',
      anchorExcerpt: '# Plan',
    });

    const result = await planChatsService.ensure(parent.id, {
      reviewId: 'exit-plan:permission-1',
      reviewSource: 'exit-plan-permission',
      permissionRequestId: 'permission-1',
      toolUseId: 'tool-1',
      planMarkdown: '# Plan\n\nDo it',
    });

    expect(provider.forkConversation).toHaveBeenCalledWith({
      parentSessionId: parent.id,
      childSessionId: result.session.id,
      anchorToolUseId: 'tool-1',
      activePermissionRequestId: 'permission-1',
      childSessionName: 'Parent plan Q&A',
    });
    expect(provider.setPlanMode).toHaveBeenCalledWith(result.session.id, true);
    expect(result.session.claudeSessionId).toBe('claude-plan-chat');
    expect(result.planChat).toEqual(
      expect.objectContaining({
        reviewId: 'exit-plan:permission-1',
        anchorMessageId: 'plan-review:exit-plan:permission-1',
        anchorMessageKind: 'assistant',
        anchorExcerpt: '# Plan',
      }),
    );

    await planChatsService.submitQuestion(parent.id, result.planChat.id, {
      question: 'Why this order?',
    });

    expect(provider.submitPrompt).toHaveBeenCalledWith(
      result.session.id,
      expect.stringContaining(
        '<elevenex_plan_excerpt>\n# Plan\n\nDo it\n</elevenex_plan_excerpt>',
      ),
      'Why this order?',
    );
  });

  it('removes the hidden child session when provider fork creation fails', async () => {
    const parent = await createParent();
    provider.forkConversation.mockRejectedValue(new Error('provider failed'));

    await expect(
      planChatsService.ensure(parent.id, {
        reviewId: 'review-1',
        anchorMessageId: 'assistant-1',
        anchorMessageKind: 'assistant',
        planMarkdown: '# Plan',
      }),
    ).rejects.toThrow('provider failed');

    const allSessions = await sessionsService.findByRepo(repoId, {
      includeHidden: true,
    });
    expect(allSessions.map((session) => session.id)).toEqual([parent.id]);
    expect(agentRuntimeCleanup.cleanupSession).toHaveBeenCalledTimes(1);
  });

  it('deletes hidden plan chat forks so a later question can start fresh', async () => {
    const parent = await createParent();
    provider.forkConversation.mockResolvedValue({
      providerSessionId: 'claude-plan-chat',
      anchorExcerpt: '# Plan',
    });
    const { planChat, session } = await planChatsService.ensure(parent.id, {
      reviewId: 'review-1',
      anchorMessageId: 'assistant-1',
      anchorMessageKind: 'assistant',
      planMarkdown: '# Plan',
    });

    await planChatsService.delete(parent.id, planChat.id);

    const allSessions = await sessionsService.findByRepo(repoId, {
      includeHidden: true,
    });
    const planChats = await planChatsService.findByParent(
      parent.id,
      'review-1',
    );
    expect(allSessions.map((item) => item.id)).not.toContain(session.id);
    expect(planChats).toEqual([]);
  });
});
