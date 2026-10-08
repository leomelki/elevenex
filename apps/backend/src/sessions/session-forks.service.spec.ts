import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import { AGENT_RUNTIME_CLEANUP_SERVICE } from '../agent-runtime/agent-runtime.tokens.js';
import { PtyManager } from '../terminal/pty-manager.service.js';
import { TmuxManager } from '../terminal/tmux-manager.service.js';
import { SessionForksService } from './session-forks.service.js';
import { SessionsService } from './sessions.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { createTestDb } from '../database/testing/create-test-db.js';

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

  async function createParent(
    activeAgentProvider: 'claude' | 'codex' = 'claude',
  ) {
    const parent = await sessionsService.create({
      repoId,
      branchName: 'main',
      worktreePath: '/tmp/worktree',
      name: 'Parent',
      activeAgentProvider,
    });
    if (activeAgentProvider === 'codex') {
      await sessionsService.updateCodexSessionId(parent.id, 'codex-parent');
    } else {
      await sessionsService.updateClaudeSessionId(parent.id, 'claude-parent');
    }
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

  it('persists the Codex fork id and edited prompt draft in the child session', async () => {
    const parent = await createParent('codex');
    provider.forkConversation.mockResolvedValue({
      providerSessionId: 'codex-child',
      draft: 'edit this prompt',
      anchorExcerpt: 'edit this prompt',
    });

    const result = await forksService.create(parent.id, {
      anchorMessageId: 'codex-record:3',
      anchorMessageKind: 'user',
    });

    expect(result.session).toMatchObject({
      activeAgentProvider: 'codex',
      codexSessionId: 'codex-child',
    });
    expect(result.draft).toBe('edit this prompt');
    expect((await forksService.findByParent(parent.id))[0]).toMatchObject({
      provider: 'codex',
      draft: 'edit this prompt',
    });
    expect((await sessionsService.findOne(parent.id)).codexSessionId).toBe(
      'codex-parent',
    );
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
