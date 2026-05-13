import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { SessionsService } from './sessions.service.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { PtyManager } from '../terminal/pty-manager.service.js';
import { TmuxManager } from '../terminal/tmux-manager.service.js';
import { AGENT_RUNTIME_CLEANUP_SERVICE } from '../agent-runtime/agent-runtime.tokens.js';

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
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      branch_name TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      name TEXT,
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
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe('SessionsService', () => {
  let service: SessionsService;
  let db: BetterSQLite3Database<typeof schema>;
  let sqliteConn: InstanceType<typeof Database>;
  let projectId: number;
  let repoId: number;
  let otherRepoId: number;
  let ptyManagerMock: { kill: jest.Mock; isAlive: jest.Mock; killTmuxSession: jest.Mock };
  let agentRuntimeCleanupMock: { cleanupSession: jest.Mock };

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    sqliteConn = testDb.sqlite;

    // Seed a project
    const projectRows = await db
      .insert(schema.projects)
      .values({ name: 'Test Project' })
      .returning();
    projectId = projectRows[0].id;

    // Seed a repo
    const repoRows = await db
      .insert(schema.repos)
      .values({ projectId, name: 'test-repo', path: '/tmp/test-repo' })
      .returning();
    repoId = repoRows[0].id;

    const otherRepoRows = await db
      .insert(schema.repos)
      .values({ projectId, name: 'other-repo', path: '/tmp/other-repo' })
      .returning();
    otherRepoId = otherRepoRows[0].id;

    ptyManagerMock = {
      kill: jest.fn(),
      isAlive: jest.fn(),
      killTmuxSession: jest.fn(),
    };
    agentRuntimeCleanupMock = {
      cleanupSession: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: DRIZZLE, useValue: db },
        { provide: PtyManager, useValue: ptyManagerMock },
        { provide: TmuxManager, useValue: { isTmuxAvailable: jest.fn(() => false), sessionExists: jest.fn(), killSession: jest.fn() } },
        { provide: AGENT_RUNTIME_CLEANUP_SERVICE, useValue: agentRuntimeCleanupMock },
      ],
    }).compile();

    service = module.get<SessionsService>(SessionsService);
  });

  afterEach(() => {
    sqliteConn.close();
  });

  describe('create', () => {
    it('should create a session with provided name', async () => {
      const result = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/worktree',
        name: 'My Session',
      });

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.repoId).toBe(repoId);
      expect(result.branchName).toBe('main');
      expect(result.worktreePath).toBe('/tmp/worktree');
      expect(result.name).toBe('My Session');
      expect(result.status).toBe('created');
      expect(result.activeAgentProvider).toBe('claude');
      expect(result.claudeSessionId).toBe('-1');
      expect(result.codexSessionId).toBe('-1');
      expect(result.hasUnreviewedCompletion).toBe(false);
      expect(result.lastCompletionAt).toBeNull();
      expect(result.lastCompletionKind).toBeNull();
      expect(result.lastStateChangeAt).toBeNull();
    });

    it('should auto-generate name as "Session N" when not provided', async () => {
      const result1 = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt1',
      });

      expect(result1.name).toBe('Session 1');

      const result2 = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt2',
      });

      expect(result2.name).toBe('Session 2');
    });

    it('should count sessions per repo+branch for auto-naming', async () => {
      // Create sessions for different branches
      await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt1',
      });

      await service.create({
        repoId,
        branchName: 'feature',
        worktreePath: '/tmp/wt2',
      });

      // Session for main branch should be Session 1 (first for main)
      const mainSession = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt3',
      });

      expect(mainSession.name).toBe('Session 2');

      // Session for feature branch should be Session 2 (second for feature)
      const featureSession = await service.create({
        repoId,
        branchName: 'feature',
        worktreePath: '/tmp/wt4',
      });

      expect(featureSession.name).toBe('Session 2');
    });
  });

  describe('findByRepo', () => {
    it('should return all sessions for a repo', async () => {
      await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt1',
        name: 'Session 1',
      });

      await service.create({
        repoId,
        branchName: 'feature',
        worktreePath: '/tmp/wt2',
        name: 'Session 2',
      });

      const sessions = await service.findByRepo(repoId);

      expect(sessions).toHaveLength(2);
    });

    it('should return empty array when repo has no sessions', async () => {
      const sessions = await service.findByRepo(repoId);
      expect(sessions).toEqual([]);
    });
  });

  describe('findByRepoAndWorktreePath', () => {
    it('should only return sessions that match both repo and worktree path', async () => {
      await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/shared-wt',
        name: 'Repo one session',
      });
      await service.create({
        repoId: otherRepoId,
        branchName: 'main',
        worktreePath: '/tmp/shared-wt',
        name: 'Repo two session',
      });

      const sessions = await service.findByRepoAndWorktreePath(
        repoId,
        '/tmp/shared-wt',
      );

      expect(sessions).toHaveLength(1);
      expect(sessions[0].repoId).toBe(repoId);
    });
  });

  describe('findOne', () => {
    it('should return a session by id', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
        name: 'Test Session',
      });

      const found = await service.findOne(created.id);

      expect(found.id).toBe(created.id);
      expect(found.name).toBe('Test Session');
    });

    it('should throw NotFoundException for non-existent id', async () => {
      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('should update session status', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
      });

      const updated = await service.updateStatus(created.id, 'active');

      expect(updated.status).toBe('active');
    });

    it('should throw BadRequestException for invalid status', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
      });

      await expect(
        service.updateStatus(created.id, 'invalid-status'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException for non-existent id', async () => {
      await expect(
        service.updateStatus(999, 'active'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteByRepoAndWorktreePath', () => {
    it('deletes only sessions that match the target repo and worktree path', async () => {
      const targetOne = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/shared-wt',
        name: 'Target 1',
      });
      const targetTwo = await service.create({
        repoId,
        branchName: 'feature',
        worktreePath: '/tmp/shared-wt',
        name: 'Target 2',
      });
      await service.create({
        repoId: otherRepoId,
        branchName: 'main',
        worktreePath: '/tmp/shared-wt',
        name: 'Other repo',
      });
      await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/other-wt',
        name: 'Other worktree',
      });

      await service.deleteByRepoAndWorktreePath(repoId, '/tmp/shared-wt');

      const remainingRepoSessions = await service.findByRepo(repoId);
      expect(remainingRepoSessions.map(session => session.id)).not.toContain(targetOne.id);
      expect(remainingRepoSessions.map(session => session.id)).not.toContain(targetTwo.id);
      expect(remainingRepoSessions).toHaveLength(1);
      expect(remainingRepoSessions[0].worktreePath).toBe('/tmp/other-wt');

      const otherRepoSessions = await service.findByRepo(otherRepoId);
      expect(otherRepoSessions).toHaveLength(1);
      expect(otherRepoSessions[0].worktreePath).toBe('/tmp/shared-wt');

      expect(ptyManagerMock.kill).toHaveBeenCalledWith(targetOne.id);
      expect(ptyManagerMock.kill).toHaveBeenCalledWith(targetTwo.id);
      expect(ptyManagerMock.killTmuxSession).toHaveBeenCalledWith(targetOne.id);
      expect(ptyManagerMock.killTmuxSession).toHaveBeenCalledWith(targetTwo.id);
    });
  });

  describe('delete', () => {
    it('should delete a session', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
      });

      await service.delete(created.id);

      expect(agentRuntimeCleanupMock.cleanupSession).toHaveBeenCalledWith(created.id);
      expect(ptyManagerMock.kill).toHaveBeenCalledWith(created.id);
      expect(ptyManagerMock.killTmuxSession).toHaveBeenCalledWith(created.id);
      await expect(service.findOne(created.id)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('tears down runtime state before deleting the database row', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
      });
      agentRuntimeCleanupMock.cleanupSession.mockImplementation(async () => {
        const existing = await service.findOne(created.id);
        expect(existing.id).toBe(created.id);
      });

      await service.delete(created.id);

      expect(agentRuntimeCleanupMock.cleanupSession).toHaveBeenCalledWith(created.id);
    });

    it('should throw NotFoundException for non-existent id', async () => {
      await expect(service.delete(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('archive', () => {
    it('marks archived and returns before process cleanup finishes', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
      });
      let resolveCleanup!: () => void;
      agentRuntimeCleanupMock.cleanupSession.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
      );

      const archived = await service.archive(created.id);

      expect(archived.status).toBe('archived');
      expect(agentRuntimeCleanupMock.cleanupSession).toHaveBeenCalledWith(created.id);
      expect(ptyManagerMock.kill).not.toHaveBeenCalledWith(created.id);
      expect(ptyManagerMock.killTmuxSession).not.toHaveBeenCalledWith(created.id);

      const persisted = await service.findOne(created.id);
      expect(persisted.status).toBe('archived');

      resolveCleanup();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(ptyManagerMock.kill).toHaveBeenCalledWith(created.id);
      expect(ptyManagerMock.killTmuxSession).toHaveBeenCalledWith(created.id);
    });

    it('still kills terminal processes asynchronously if agent cleanup fails', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
      });
      agentRuntimeCleanupMock.cleanupSession.mockRejectedValueOnce(new Error('cleanup failed'));

      const archived = await service.archive(created.id);
      expect(archived.status).toBe('archived');

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(ptyManagerMock.kill).toHaveBeenCalledWith(created.id);
      expect(ptyManagerMock.killTmuxSession).toHaveBeenCalledWith(created.id);
    });
  });

  describe('unarchive', () => {
    it('restores archived sessions as stopped', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
      });
      await service.archive(created.id);

      const restored = await service.unarchive(created.id);

      expect(restored.status).toBe('stopped');
    });

    it('rejects non-archived sessions', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
      });

      await expect(service.unarchive(created.id)).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for non-existent sessions', async () => {
      await expect(service.unarchive(99999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('fork', () => {
    it('should create new session in same worktree', async () => {
      // Create original session
      const original = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/path/to/worktree',
        name: 'Original Session',
      });

      // Fork it
      const forked = await service.fork(original.id);

      expect(forked.id).not.toBe(original.id);
      expect(forked.repoId).toBe(original.repoId);
      expect(forked.branchName).toBe(original.branchName);
      expect(forked.worktreePath).toBe(original.worktreePath);
      expect(forked.status).toBe('created');
    });

    it('should generate name with (fork) suffix', async () => {
      const original = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/path',
        name: 'My Session',
      });

      const forked = await service.fork(original.id);
      expect(forked.name).toBe('My Session (fork)');
    });

    it('should use provided name if given', async () => {
      const original = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/path',
        name: 'Original',
      });

      const forked = await service.fork(original.id, 'Custom Name');
      expect(forked.name).toBe('Custom Name');
    });

    it('should throw NotFoundException for invalid session', async () => {
      await expect(service.fork(99999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('kill', () => {
    it('should kill PTY process', async () => {
      const session = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/path',
      });

      // Get the mock PTY manager from the service
      const ptyManager = (service as any).ptyManager;
      const killSpy = jest.spyOn(ptyManager, 'kill').mockReturnValue(true);
      const killTmuxSpy = jest.spyOn(ptyManager, 'killTmuxSession').mockImplementation();

      await service.kill(session.id);

      expect(killSpy).toHaveBeenCalledWith(session.id);
      expect(killTmuxSpy).toHaveBeenCalledWith(session.id);
    });

    it('should update status to stopped', async () => {
      const session = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/path',
      });

      // Set to active first
      await service.updateStatus(session.id, 'active');

      const killed = await service.kill(session.id);
      expect(killed.status).toBe('stopped');
    });

    it('should be idempotent (work if PTY not running)', async () => {
      const session = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/path',
      });

      // PTY manager returns false when no process
      const ptyManager = (service as any).ptyManager;
      jest.spyOn(ptyManager, 'kill').mockReturnValue(false);
      jest.spyOn(ptyManager, 'killTmuxSession').mockImplementation();

      // Should not throw
      const killed = await service.kill(session.id);
      expect(killed.status).toBe('stopped');
    });

    it('should throw NotFoundException for invalid session', async () => {
      await expect(service.kill(99999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('completion marker', () => {
    it('should mark a completion as unreviewed', async () => {
      const session = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/path',
      });

      const updated = await service.markCompletionUnreviewed(session.id, 'completed');

      expect(updated.hasUnreviewedCompletion).toBe(true);
      expect(updated.lastCompletionKind).toBe('completed');
      expect(updated.lastCompletionAt).toBeTruthy();
    });

    it('should clear a completion marker when reviewed', async () => {
      const session = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/path',
      });

      await service.markCompletionUnreviewed(session.id, 'completed');
      const cleared = await service.markCompletionReviewed(session.id);

      expect(cleared.hasUnreviewedCompletion).toBe(false);
      expect(cleared.lastCompletionKind).toBe('completed');
      expect(cleared.lastCompletionAt).toBeTruthy();
    });
  });

  describe('last state change marker', () => {
    it('should persist lastStateChangeAt and emit an event payload', async () => {
      const session = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/path',
      });
      const listener = jest.fn();
      service.on('session-last-state-change-changed', listener);

      const updated = await service.markLastStateChange(session.id, '2024-01-03T10:00:00.000Z');

      expect(updated.lastStateChangeAt).toBe('2024-01-03T10:00:00.000Z');
      expect(listener).toHaveBeenCalledWith({
        sessionId: session.id,
        lastStateChangeAt: '2024-01-03T10:00:00.000Z',
      });
    });
  });

  describe('updateClaudeSessionId', () => {
    it('stores a Claude session id for an existing session', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
        name: 'Tracked Session',
      });

      const updated = await service.updateClaudeSessionId(created.id, 'claude-session-1');

      expect(updated.claudeSessionId).toBe('claude-session-1');
      expect(updated.activeAgentProvider).toBe('claude');
      const reloaded = await service.findOne(created.id);
      expect(reloaded.claudeSessionId).toBe('claude-session-1');
      expect(reloaded.activeAgentProvider).toBe('claude');
    });

    it('returns early without rewriting when the Claude session id is unchanged', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
        name: 'Tracked Session',
      });

      await service.updateClaudeSessionId(created.id, 'claude-session-1');
      const unchanged = await service.updateClaudeSessionId(created.id, 'claude-session-1');

      expect(unchanged.claudeSessionId).toBe('claude-session-1');
      expect(unchanged.activeAgentProvider).toBe('claude');
      const reloaded = await service.findOne(created.id);
      expect(reloaded.claudeSessionId).toBe('claude-session-1');
      expect(reloaded.activeAgentProvider).toBe('claude');
    });
  });

  describe('updateCodexSessionId', () => {
    it('stores a Codex session id and marks Codex as the active provider', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
        name: 'Tracked Session',
      });

      const updated = await service.updateCodexSessionId(created.id, 'codex-session-1');

      expect(updated.codexSessionId).toBe('codex-session-1');
      expect(updated.activeAgentProvider).toBe('codex');
      const reloaded = await service.findOne(created.id);
      expect(reloaded.codexSessionId).toBe('codex-session-1');
      expect(reloaded.activeAgentProvider).toBe('codex');
    });
  });

  describe('updatePiSessionPath', () => {
    it('stores a Pi session path and marks Pi as the active provider', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
        name: 'Tracked Session',
      });

      const updated = await service.updatePiSessionPath(
        created.id,
        '/Users/test/.pi/agent/sessions/session.jsonl',
      );

      expect(updated.piSessionPath).toBe('/Users/test/.pi/agent/sessions/session.jsonl');
      expect(updated.activeAgentProvider).toBe('pi');
      const reloaded = await service.findOne(created.id);
      expect(reloaded.piSessionPath).toBe('/Users/test/.pi/agent/sessions/session.jsonl');
      expect(reloaded.activeAgentProvider).toBe('pi');
    });
  });

  describe('updateActiveAgentProvider', () => {
    it('stores the preferred provider for an existing session', async () => {
      const created = await service.create({
        repoId,
        branchName: 'main',
        worktreePath: '/tmp/wt',
        name: 'Tracked Session',
      });

      const updated = await service.updateActiveAgentProvider(created.id, 'codex');

      expect(updated.activeAgentProvider).toBe('codex');
      const reloaded = await service.findOne(created.id);
      expect(reloaded.activeAgentProvider).toBe('codex');
    });
  });
});
