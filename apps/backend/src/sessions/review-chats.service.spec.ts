import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DRIZZLE } from '../database/database.provider.js';
import { createTestDb } from '../database/testing/create-test-db.js';
import * as schema from '../database/schema/index.js';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import { AGENT_RUNTIME_CLEANUP_SERVICE } from '../agent-runtime/agent-runtime.tokens.js';
import { PtyManager } from '../terminal/pty-manager.service.js';
import { TmuxManager } from '../terminal/tmux-manager.service.js';
import { ReviewChatsService } from './review-chats.service.js';
import { SessionsService } from './sessions.service.js';
import { SettingsService } from '../settings/settings.service.js';

const ANCHOR = {
  filePath: 'src/app/foo.ts',
  scope: 'branch',
  changeHash: 'hash-1',
  fingerprint: 'fp-1',
  newLineStart: 12,
  newLineEnd: 18,
  selectedText: 'const a = compute();',
};

describe('ReviewChatsService', () => {
  let sessionsService: SessionsService;
  let reviewChats: ReviewChatsService;
  let db: BetterSQLite3Database<typeof schema>;
  let sqliteConn: InstanceType<typeof Database>;
  let repoId: number;
  let provider: {
    forkConversation: jest.Mock;
    setPlanMode: jest.Mock;
    submitPrompt: jest.Mock;
    getHistory: jest.Mock;
    getRuntimeState: jest.Mock;
  };
  let registry: {
    getProviderFeature: jest.Mock;
    getProvider: jest.Mock;
  };

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
      forkConversation: jest
        .fn()
        .mockResolvedValue({ providerSessionId: 'claude-review-chat' }),
      setPlanMode: jest.fn().mockResolvedValue({}),
      submitPrompt: jest.fn().mockResolvedValue(undefined),
      getHistory: jest.fn().mockResolvedValue([
        { id: 'u1', kind: 'user', transcriptMessageId: 'uuid-user' },
        { id: 'a1', kind: 'assistant', transcriptMessageId: 'uuid-done' },
        { id: 'a2', kind: 'assistant', transcriptMessageId: 'uuid-live' },
      ]),
      getRuntimeState: jest.fn().mockResolvedValue({ runPhase: 'idle' }),
    };

    registry = {
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
        ReviewChatsService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: PtyManager,
          useValue: { kill: jest.fn(), killTmuxSession: jest.fn() },
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
          useValue: { cleanupSession: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SettingsService,
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              defaultClaudeSessionSurface: 'claude-ui',
              defaultAgentProvider: 'claude',
              sessionToolbarButtons: null,
              onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
              createdAt: null,
              updatedAt: null,
            }),
          },
        },
        { provide: ModuleRef, useValue: moduleRef },
      ],
    }).compile();

    sessionsService = module.get(SessionsService);
    reviewChats = module.get(ReviewChatsService);
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

  it('forks a hidden, plan-mode-locked child anchored to the selection', async () => {
    const parent = await createParent();

    const result = await reviewChats.create(parent.id, { anchors: [ANCHOR] });

    expect(result.reviewChat.mode).toBe('readonly');
    expect(result.reviewChat.status).toBe('open');
    expect(result.reviewChat.filePath).toBe('src/app/foo.ts');
    expect(result.reviewChat.anchors).toHaveLength(1);
    expect(result.session.surface).toBe('embedded_review_chat');
    expect(provider.setPlanMode).toHaveBeenCalledWith(result.session.id, true);
  });

  it('derives a readable default title from the anchor', async () => {
    const parent = await createParent();

    const result = await reviewChats.create(parent.id, { anchors: [ANCHOR] });

    expect(result.reviewChat.title).toBe('foo.ts:12-18');
  });

  it('anchors at the latest completed turn when the parent is idle', async () => {
    const parent = await createParent();

    await reviewChats.create(parent.id, { anchors: [ANCHOR] });

    expect(provider.forkConversation).toHaveBeenCalledWith(
      expect.objectContaining({ anchorMessageId: 'uuid-live' }),
    );
  });

  it('skips the live head so a busy parent can still start a discussion', async () => {
    // Forking reads the on-disk transcript up to a message, so it is safe
    // mid-turn as long as the anchor is already persisted.
    provider.getRuntimeState.mockResolvedValue({ runPhase: 'running' });
    const parent = await createParent();

    const result = await reviewChats.create(parent.id, { anchors: [ANCHOR] });

    expect(provider.forkConversation).toHaveBeenCalledWith(
      expect.objectContaining({ anchorMessageId: 'uuid-done' }),
    );
    expect(result.reviewChat.id).toBeDefined();
  });

  it('honours an explicit anchor from the caller', async () => {
    const parent = await createParent();

    await reviewChats.create(parent.id, {
      anchors: [ANCHOR],
      anchorMessageId: 'uuid-specific',
      anchorMessageKind: 'assistant',
    });

    expect(provider.forkConversation).toHaveBeenCalledWith(
      expect.objectContaining({ anchorMessageId: 'uuid-specific' }),
    );
  });

  it('refuses a fork that produced no provider session and cleans up the child', async () => {
    // A null provider session id means the child would start a fresh
    // conversation with none of the review context — useless and confusing.
    provider.forkConversation.mockResolvedValue({ providerSessionId: null });
    const parent = await createParent();

    await expect(
      reviewChats.create(parent.id, { anchors: [ANCHOR] }),
    ).rejects.toThrow(/Could not fork the conversation/i);

    const sessions = await sessionsService.findByRepo(repoId);
    expect(sessions.map((session) => session.id)).toEqual([parent.id]);
  });

  it('cleans up the child session when forking throws', async () => {
    provider.forkConversation.mockRejectedValue(new Error('fork exploded'));
    const parent = await createParent();

    await expect(
      reviewChats.create(parent.id, { anchors: [ANCHOR] }),
    ).rejects.toThrow('fork exploded');

    const sessions = await sessionsService.findByRepo(repoId);
    expect(sessions.map((session) => session.id)).toEqual([parent.id]);
  });

  it('rejects providers that cannot fork a conversation', async () => {
    const parent = await sessionsService.create({
      repoId,
      branchName: 'main',
      worktreePath: '/tmp/worktree',
      name: 'Antigravity parent',
      activeAgentProvider: 'antigravity',
    });

    await expect(
      reviewChats.create(parent.id, { anchors: [ANCHOR] }),
    ).rejects.toThrow(/not supported for agent provider/i);
  });

  it('requires at least one anchor', async () => {
    const parent = await createParent();

    await expect(reviewChats.create(parent.id, { anchors: [] })).rejects.toThrow(
      /at least one code selection/i,
    );
  });

  it('caps the number of open discussions per session', async () => {
    const parent = await createParent();
    for (let index = 0; index < 6; index += 1) {
      provider.forkConversation.mockResolvedValue({
        providerSessionId: `claude-review-${index}`,
      });
      await reviewChats.create(parent.id, { anchors: [ANCHOR] });
    }

    await expect(
      reviewChats.create(parent.id, { anchors: [ANCHOR] }),
    ).rejects.toThrow(/already have 6 open review discussions/i);
  });

  it('does not count resolved discussions against the cap', async () => {
    const parent = await createParent();
    const created = [];
    for (let index = 0; index < 6; index += 1) {
      provider.forkConversation.mockResolvedValue({
        providerSessionId: `claude-review-${index}`,
      });
      created.push(await reviewChats.create(parent.id, { anchors: [ANCHOR] }));
    }
    await reviewChats.update(parent.id, created[0].reviewChat.id, {
      status: 'resolved',
    });

    provider.forkConversation.mockResolvedValue({
      providerSessionId: 'claude-review-extra',
    });
    await expect(
      reviewChats.create(parent.id, { anchors: [ANCHOR] }),
    ).resolves.toBeDefined();
  });

  it('wraps a message in a read-only guard naming the anchored code', async () => {
    const parent = await createParent();
    const { reviewChat } = await reviewChats.create(parent.id, {
      anchors: [ANCHOR],
    });

    await reviewChats.submitMessage(parent.id, reviewChat.id, {
      message: 'Why is this recomputed?',
    });

    const [, prompt, visible] = provider.submitPrompt.mock.calls[0];
    expect(prompt).toContain('src/app/foo.ts');
    expect(prompt).toContain('lines: 12-18');
    expect(prompt).toContain('Do not modify files');
    expect(prompt).toContain('Why is this recomputed?');
    expect(visible).toBe('Why is this recomputed?');
  });

  it('drops the read-only guard once edits are unlocked', async () => {
    const parent = await createParent();
    const { reviewChat } = await reviewChats.create(parent.id, {
      anchors: [ANCHOR],
    });

    await reviewChats.update(parent.id, reviewChat.id, { mode: 'write' });
    await reviewChats.submitMessage(parent.id, reviewChat.id, {
      message: 'Fix it',
    });

    const [, prompt] = provider.submitPrompt.mock.calls[0];
    expect(prompt).not.toContain('Do not modify files');
    expect(prompt).toContain('Edits are enabled');
  });

  it('turns plan mode off when unlocking edits and back on when locking', async () => {
    const parent = await createParent();
    const { reviewChat, session } = await reviewChats.create(parent.id, {
      anchors: [ANCHOR],
    });

    await reviewChats.update(parent.id, reviewChat.id, { mode: 'write' });
    expect(provider.setPlanMode).toHaveBeenLastCalledWith(session.id, false);

    await reviewChats.update(parent.id, reviewChat.id, { mode: 'readonly' });
    expect(provider.setPlanMode).toHaveBeenLastCalledWith(session.id, true);
  });

  it('accumulates further selections onto an existing discussion', async () => {
    const parent = await createParent();
    const { reviewChat } = await reviewChats.create(parent.id, {
      anchors: [ANCHOR],
    });

    const updated = await reviewChats.addAnchors(parent.id, reviewChat.id, {
      anchors: [{ ...ANCHOR, filePath: 'src/app/bar.ts', newLineStart: 4 }],
    });

    expect(updated.anchors).toHaveLength(2);
    expect(updated.anchors[1].filePath).toBe('src/app/bar.ts');
  });

  it('promotes a discussion into a standalone session with its conversation intact', async () => {
    const parent = await createParent();
    const { reviewChat, session } = await reviewChats.create(parent.id, {
      anchors: [ANCHOR],
    });

    const promoted = await reviewChats.promote(parent.id, reviewChat.id);

    expect(promoted.session.surface).toBe('session');
    expect(promoted.fork.childSessionId).toBe(session.id);
    expect(provider.setPlanMode).toHaveBeenLastCalledWith(session.id, false);

    const [after] = await reviewChats.findByParent(parent.id);
    expect(after.status).toBe('promoted');
    expect(after.promotedForkId).toBe(promoted.fork.id);

    // It is now a real session, so it shows up in normal listings.
    const listed = await sessionsService.findByRepo(repoId);
    expect(listed.map((item) => item.id)).toContain(session.id);
  });

  it('refuses to promote the same discussion twice', async () => {
    const parent = await createParent();
    const { reviewChat } = await reviewChats.create(parent.id, {
      anchors: [ANCHOR],
    });
    await reviewChats.promote(parent.id, reviewChat.id);

    await expect(
      reviewChats.promote(parent.id, reviewChat.id),
    ).rejects.toThrow(/already been opened as a session/i);
  });

  it('hides discussions from normal session listings until promoted', async () => {
    const parent = await createParent();
    await reviewChats.create(parent.id, { anchors: [ANCHOR] });

    const listed = await sessionsService.findByRepo(repoId);
    expect(listed.map((item) => item.id)).toEqual([parent.id]);
  });

  it('lists discussions for a parent and filters by file', async () => {
    const parent = await createParent();
    await reviewChats.create(parent.id, { anchors: [ANCHOR] });
    provider.forkConversation.mockResolvedValue({
      providerSessionId: 'claude-review-2',
    });
    await reviewChats.create(parent.id, {
      anchors: [{ ...ANCHOR, filePath: 'src/app/bar.ts' }],
    });

    expect(await reviewChats.findByParent(parent.id)).toHaveLength(2);
    const filtered = await reviewChats.findByParent(parent.id, 'src/app/bar.ts');
    expect(filtered.map((chat) => chat.filePath)).toEqual(['src/app/bar.ts']);
  });

  it('records when a discussion was last read', async () => {
    const parent = await createParent();
    const { reviewChat } = await reviewChats.create(parent.id, {
      anchors: [ANCHOR],
    });
    expect(reviewChat.lastReadAt).toBeNull();

    const updated = await reviewChats.update(parent.id, reviewChat.id, {
      markRead: true,
    });

    expect(updated.lastReadAt).toBeTruthy();
  });

  it('deletes the discussion together with its child session', async () => {
    const parent = await createParent();
    const { reviewChat, session } = await reviewChats.create(parent.id, {
      anchors: [ANCHOR],
    });

    await reviewChats.delete(parent.id, reviewChat.id);

    expect(await reviewChats.findByParent(parent.id)).toHaveLength(0);
    await expect(sessionsService.findOne(session.id)).rejects.toThrow();
  });

  it('refuses to start a discussion on an archived session', async () => {
    const parent = await createParent();
    await sessionsService.archive(parent.id);

    await expect(
      reviewChats.create(parent.id, { anchors: [ANCHOR] }),
    ).rejects.toThrow(/Archived sessions are read-only/i);
  });

  it('reports when the session has no completed turn to fork from', async () => {
    provider.getHistory.mockResolvedValue([]);
    const parent = await createParent();

    await expect(
      reviewChats.create(parent.id, { anchors: [ANCHOR] }),
    ).rejects.toThrow(/no completed turn/i);
  });
});
