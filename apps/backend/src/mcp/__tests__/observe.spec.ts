import { EventEmitter } from 'node:events';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import type { ToolContext } from '../tool-registry/tool.types.js';
import { ToolError } from '../tool-registry/tool.types.js';
import { sessionStatusTool } from '../tools/observe/session-status.tool.js';
import { readSessionTool } from '../tools/observe/read-session.tool.js';
import { textSearchTool } from '../tools/observe/text-search.tool.js';
import { readFileTool } from '../tools/observe/read-file.tool.js';
import { changeReviewTool } from '../tools/observe/change-review.tool.js';
import { awaitSessionEventTool } from '../tools/observe/await-session-event.tool.js';
import { OBSERVE_TOOLS } from '../tools/observe/index.js';
import { ConversationExportService } from '../../agent-runtime/conversation-export.service.js';

function makeCtx(
  services: unknown,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    services,
    agentSessionId: 42,
    caps: {
      isAgent: true,
      canMutate: true,
      canDestroy: true,
      canUseHumanChannel: true,
    },
    cursors: new DeltaCursorStore(),
    deepLink: new DeepLinkBuilder(),
    human: {} as unknown,
    signal: new AbortController().signal,
    mcpSessionId: 't',
    ...overrides,
  } as unknown as ToolContext;
}

const baseSession = {
  id: 7,
  name: 'S7',
  status: 'running',
  branchName: 'feat/x',
  worktreePath: '/wt/7',
  activeAgentProvider: 'claude',
  hasUnreviewedCompletion: false,
  lastCompletionAt: null,
  lastStateChangeAt: '2026-06-17T00:00:00.000Z',
  repoId: 3,
};

function sessionsMock(session: Record<string, unknown> | null = baseSession) {
  return {
    findOne: jest.fn(async (id: number) => {
      if (session === null) throw new Error('not found');
      return { ...session, id };
    }),
  };
}

describe('observe tool group', () => {
  it('registers all ten tools including the two pre-existing ones', () => {
    const names = OBSERVE_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'project_overview',
        'find_sessions',
        'session_status',
        'read_session',
        'text_search',
        'file_search',
        'read_file',
        'change_review',
        'get_worktree_context',
        'await_session_event',
      ]),
    );
    expect(OBSERVE_TOOLS).toHaveLength(10);
  });

  describe('session_status', () => {
    it('compacts DB + runtime state and reports a pending action', async () => {
      const services = {
        sessions: sessionsMock({ ...baseSession, hasUnreviewedCompletion: true }),
        agentRuntime: {
          getProvider: () => ({
            getRuntimeState: jest.fn().mockResolvedValue({
              sessionState: 'requires_action',
              pendingPermissionRequest: { requestId: 'r1' },
              pendingUserInputRequest: null,
            }),
          }),
        },
      };
      const res = await sessionStatusTool.handler({ sessionId: 7 }, makeCtx(services));
      expect(res.data).toMatchObject({
        sessionId: 7,
        status: 'running',
        runtimeState: 'requires_action',
        needsReview: true,
        hasPendingAction: true,
      });
      expect(res.nextStep).toContain('get_pending_action');
    });

    it('falls back to DB status when runtime is not started', async () => {
      const services = {
        sessions: sessionsMock(),
        agentRuntime: {
          getProvider: () => ({
            getRuntimeState: jest.fn().mockRejectedValue(new Error('cold')),
          }),
        },
      };
      const res = await sessionStatusTool.handler({ sessionId: 7 }, makeCtx(services));
      expect(res.data).toMatchObject({
        runtimeState: 'running',
        hasPendingAction: false,
      });
    });

    it('throws a ToolError for an unknown session', async () => {
      const services = {
        sessions: sessionsMock(null),
        agentRuntime: { getProvider: jest.fn() },
      };
      await expect(
        sessionStatusTool.handler({ sessionId: 99 }, makeCtx(services)),
      ).rejects.toBeInstanceOf(ToolError);
    });
  });

  describe('read_session', () => {
    function exportMock(history: { id: string; kind: string; content?: string }[]) {
      const conversationExport = {
        // Re-implement readDelta's contract minimally over a provided history so
        // the tool's cursor + compacting wiring is what's under test.
        readDelta: jest.fn(
          async (
            _sessionId: number,
            _provider: string,
            opts: { sinceMessageId?: string; ids?: string[]; limit?: number },
          ) => {
            const total = history.length;
            const lastMessageId = total ? history[total - 1].id : null;
            let selected = history;
            if (opts.ids?.length) {
              const want = new Set(opts.ids);
              selected = history.filter((h) => want.has(h.id));
            } else if (opts.sinceMessageId) {
              const idx = history.findIndex((h) => h.id === opts.sinceMessageId);
              selected = idx === -1 ? history : history.slice(idx + 1);
            }
            return {
              items: selected.map((h) => ({
                id: h.id,
                role: h.kind,
                text: h.content,
              })),
              lastMessageId,
              running: false,
              total,
              truncated: false,
            };
          },
        ),
      };
      return { sessions: sessionsMock(), conversationExport };
    }

    it('returns a delta and advances the cursor (second read is empty)', async () => {
      const services = exportMock([
        { id: 'm1', kind: 'user', content: 'hi' },
        { id: 'm2', kind: 'assistant', content: 'hello' },
      ]);
      const ctx = makeCtx(services);

      const first = await readSessionTool.handler(
        { sessionId: 7, limit: 30, format: 'compact' },
        ctx,
      );
      expect(first.data).toMatchObject({ newItems: 2 });
      expect(ctx.cursors.get('t', 7)).toBe('m2');

      const second = await readSessionTool.handler(
        { sessionId: 7, limit: 30, format: 'compact' },
        ctx,
      );
      expect(second.data).toMatchObject({ newItems: 0 });
      expect(second.nextStep).toContain('No new items');
    });
  });

  describe('ConversationExportService.readDelta', () => {
    function makeService(
      history: { id: string; kind: string; content?: string; toolName?: string }[],
      runtimeState: Record<string, unknown> = { sessionState: 'idle' },
    ) {
      const provider = {
        getHistory: jest.fn().mockResolvedValue(history),
        getRuntimeState: jest.fn().mockResolvedValue(runtimeState),
      };
      const registry = { getProvider: jest.fn().mockReturnValue(provider) };
      const sessionsService = {} as never;
      return new ConversationExportService(registry as never, sessionsService);
    }

    const history = [
      { id: 'a', kind: 'user', content: 'do it' },
      { id: 'b', kind: 'tool_use', toolName: 'Bash', content: '' },
      { id: 'c', kind: 'assistant', content: 'done' },
    ];

    it('returns compact items since a cursor and the last id', async () => {
      const svc = makeService(history);
      const res = await svc.readDelta(7, 'claude', { sinceMessageId: 'a' });
      expect(res.items.map((i) => i.id)).toEqual(['b', 'c']);
      expect(res.items[0]).toMatchObject({ id: 'b', role: 'tool_use', tool: 'Bash' });
      expect(res.lastMessageId).toBe('c');
      expect(res.total).toBe(3);
      expect(res.running).toBe(false);
    });

    it('fetches only specific ids when ids given', async () => {
      const svc = makeService(history);
      const res = await svc.readDelta(7, 'claude', { ids: ['c'] });
      expect(res.items.map((i) => i.id)).toEqual(['c']);
    });

    it('caps to limit (most recent) and flags truncated', async () => {
      const svc = makeService(history);
      const res = await svc.readDelta(7, 'claude', { limit: 1 });
      expect(res.items.map((i) => i.id)).toEqual(['c']);
      expect(res.truncated).toBe(true);
    });

    it('flags running from the runtime state', async () => {
      const svc = makeService(history, { sessionState: 'running' });
      const res = await svc.readDelta(7, 'claude', {});
      expect(res.running).toBe(true);
    });
  });

  describe('text_search', () => {
    it('maps results and flags truncation at the cap', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        path: `src/f${i}.ts`,
        lineNumber: i + 1,
        lineText: `match ${i}`,
        ranges: [],
      }));
      const services = {
        sessions: sessionsMock(),
        files: { searchText: jest.fn().mockResolvedValue(rows) },
      };
      const res = await textSearchTool.handler(
        {
          sessionId: 7,
          query: 'match',
          isRegExp: false,
          isCaseSensitive: false,
          maxResults: 3,
        },
        makeCtx(services),
      );
      expect(res.data).toMatchObject({ count: 3 });
      expect((res.data as { matches: unknown[] }).matches).toHaveLength(3);
      expect(res.truncated).toBe(true);
      expect(services.files.searchText).toHaveBeenCalledWith(
        '/wt/7',
        expect.objectContaining({ query: 'match', maxResults: 3 }),
      );
    });
  });

  describe('read_file', () => {
    it('windows the requested line range', async () => {
      const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join(
        '\n',
      );
      const services = {
        sessions: sessionsMock(),
        files: {
          readFile: jest.fn().mockResolvedValue({ content, language: 'typescript' }),
        },
      };
      const res = await readFileTool.handler(
        { sessionId: 7, path: 'src/a.ts', startLine: 5, endLine: 8 },
        makeCtx(services),
      );
      const data = res.data as {
        content: string;
        startLine: number;
        endLine: number;
        totalLines: number;
      };
      expect(data.startLine).toBe(5);
      expect(data.endLine).toBe(8);
      expect(data.totalLines).toBe(50);
      expect(data.content).toBe('line 5\nline 6\nline 7\nline 8');
    });
  });

  describe('change_review', () => {
    it('compacts totals and the file list', async () => {
      const services = {
        sessions: sessionsMock(),
        changeReview: {
          getSummary: jest.fn().mockResolvedValue({
            scope: 'uncommitted',
            branch: 'feat/x',
            baseRef: 'main',
            compareLabel: 'vs main',
            totals: { files: 1, additions: 5, deletions: 2 },
            files: [
              {
                path: 'src/a.ts',
                status: 'modified',
                additions: 5,
                deletions: 2,
                binary: false,
              },
            ],
            loadGuard: null,
          }),
        },
      };
      const res = await changeReviewTool.handler(
        { sessionId: 7, scope: 'uncommitted' },
        makeCtx(services),
      );
      const data = res.data as {
        totals: { files: number; additions: number };
        files: { path: string; status: string }[];
      };
      expect(data.totals).toEqual({ files: 1, additions: 5, deletions: 2 });
      expect(data.files[0]).toMatchObject({ path: 'src/a.ts', status: 'M' });
      expect(res.deepLink).toContain('panel=changes');
    });

    it('returns a narrow-scope note when the load guard blocks', async () => {
      const services = {
        sessions: sessionsMock(),
        changeReview: {
          getSummary: jest.fn().mockResolvedValue({
            scope: 'uncommitted',
            branch: 'feat/x',
            baseRef: null,
            compareLabel: 'working tree',
            totals: { files: 0, additions: 0, deletions: 0 },
            files: [],
            loadGuard: {
              blocked: true,
              threshold: 2000,
              totalFiles: 5000,
              reason: 'worktree',
            },
          }),
        },
      };
      const res = await changeReviewTool.handler(
        { sessionId: 7, scope: 'uncommitted' },
        makeCtx(services),
      );
      expect(res.data).toMatchObject({ blocked: true, totalFiles: 5000 });
      expect(res.truncated).toBe(true);
      expect(res.nextStep).toContain('narrow');
    });
  });

  describe('await_session_event', () => {
    it('resolves when a matching session-status-changed is emitted', async () => {
      const sessions = new EventEmitter() as EventEmitter & {
        findOne: jest.Mock;
      };
      sessions.findOne = jest.fn(async (id: number) => ({
        ...baseSession,
        id,
        status: 'running',
      }));
      const ctx = makeCtx({ sessions });

      const pending = awaitSessionEventTool.handler(
        { sessionId: 7, events: ['completed'], timeoutMs: 5000 },
        ctx,
      );
      // Let the handler resolve findOne and subscribe before emitting.
      await new Promise((r) => setTimeout(r, 10));
      sessions.emit('session-status-changed', { sessionId: 7, status: 'completed' });

      const res = await pending;
      expect(res.data).toMatchObject({ event: 'completed', status: 'completed' });
      expect(sessions.listenerCount('session-status-changed')).toBe(0);
    });

    it('resolves with timeout and leaks no listener', async () => {
      const sessions = new EventEmitter() as EventEmitter & {
        findOne: jest.Mock;
      };
      sessions.findOne = jest.fn(async (id: number) => ({
        ...baseSession,
        id,
        status: 'running',
      }));
      const ctx = makeCtx({ sessions });

      const res = await awaitSessionEventTool.handler(
        { sessionId: 7, events: ['completed'], timeoutMs: 5 },
        ctx,
      );
      expect(res.data).toMatchObject({ event: 'timeout' });
      expect(sessions.listenerCount('session-status-changed')).toBe(0);
    });

    it('resolves immediately when already in a wanted state', async () => {
      const sessions = new EventEmitter() as EventEmitter & {
        findOne: jest.Mock;
      };
      sessions.findOne = jest.fn(async (id: number) => ({
        ...baseSession,
        id,
        status: 'completed',
      }));
      const res = await awaitSessionEventTool.handler(
        { sessionId: 7, events: ['completed'], timeoutMs: 5000 },
        makeCtx({ sessions }),
      );
      expect(res.data).toMatchObject({ event: 'completed' });
    });
  });
});
