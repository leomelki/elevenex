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
import { SessionForksService } from './session-forks.service.js';
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
    CREATE TABLE session_forks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      child_session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      anchor_message_id TEXT NOT NULL,
      anchor_message_kind TEXT NOT NULL,
      anchor_excerpt TEXT,
      draft TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

describe('SessionForksService', () => {
  let sessionsService: SessionsService;
  let forksService: SessionForksService;
  let db: BetterSQLite3Database<typeof schema>;
  let sqliteConn: InstanceType<typeof Database>;
  let repoId: number;
  let provider: { forkConversation: jest.Mock };
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
    };
    const moduleRef = {
      get: jest.fn((token) =>
        token === AgentRuntimeRegistryService ? registry : null,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionsService,
        SessionForksService,
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
    forksService = module.get(SessionForksService);
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

  it('allows multiple forks from the same anchor message', async () => {
    const parent = await createParent();
    provider.forkConversation
      .mockResolvedValueOnce({
        providerSessionId: 'claude-child-one',
        draft: null,
        anchorExcerpt: 'Done',
      })
      .mockResolvedValueOnce({
        providerSessionId: 'claude-child-two',
        draft: null,
        anchorExcerpt: 'Done',
      });

    const first = await forksService.create(parent.id, {
      anchorMessageId: 'assistant-1',
      anchorMessageKind: 'assistant',
    });
    const second = await forksService.create(parent.id, {
      anchorMessageId: 'assistant-1',
      anchorMessageKind: 'assistant',
    });

    expect(first.session.id).not.toBe(second.session.id);
    expect(first.fork.anchorMessageId).toBe('assistant-1');
    expect(second.fork.anchorMessageId).toBe('assistant-1');
    expect(provider.forkConversation).toHaveBeenCalledTimes(2);
  });

  it('lists fork metadata with child sessions', async () => {
    const parent = await createParent();
    provider.forkConversation.mockResolvedValue({
      providerSessionId: 'claude-child',
      draft: 'draft text',
      anchorExcerpt: 'Question',
    });

    await forksService.create(parent.id, {
      anchorMessageId: 'user-1',
      anchorMessageKind: 'user',
    });

    const forks = await forksService.findByParent(parent.id);

    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({
      parentSessionId: parent.id,
      provider: 'claude',
      anchorMessageId: 'user-1',
      anchorMessageKind: 'user',
      anchorExcerpt: 'Question',
      draft: 'draft text',
    });
    expect(forks[0].childSession?.claudeSessionId).toBe('claude-child');
  });

  it('removes the child session when provider fork creation fails', async () => {
    const parent = await createParent();
    provider.forkConversation.mockRejectedValue(new Error('provider failed'));

    await expect(
      forksService.create(parent.id, {
        anchorMessageId: 'assistant-1',
        anchorMessageKind: 'assistant',
      }),
    ).rejects.toThrow('provider failed');

    const sessions = await sessionsService.findByRepo(repoId);
    expect(sessions.map((session) => session.id)).toEqual([parent.id]);
    expect(agentRuntimeCleanup.cleanupSession).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy session forks independent from message fork metadata', async () => {
    const parent = await createParent();

    const legacyFork = await sessionsService.fork(parent.id);
    const forks = await forksService.findByParent(parent.id);

    expect(legacyFork.name).toBe('Parent (fork)');
    expect(forks).toEqual([]);
  });
});
