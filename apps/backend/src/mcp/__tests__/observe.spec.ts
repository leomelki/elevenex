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
import { grepSessionTool } from '../tools/observe/grep-session.tool.js';
import { readSessionRangeTool } from '../tools/observe/read-session-range.tool.js';
import { OBSERVE_TOOLS } from '../tools/observe/index.js';
import {
  ConversationExportService,
  buildExportModel,
} from '../../agent-runtime/conversation-export.service.js';

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
  it('registers all twelve tools including the two pre-existing ones', () => {
    const names = OBSERVE_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'project_overview',
        'find_sessions',
        'session_status',
        'read_session',
        'grep_session',
        'read_session_range',
        'text_search',
        'file_search',
        'read_file',
        'change_review',
        'get_worktree_context',
        'await_session_event',
      ]),
    );
    expect(OBSERVE_TOOLS).toHaveLength(12);
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
    function makeTurn(userContent: string, assistantContent: string) {
      return {
        user: { id: `u-${userContent}`, kind: 'user', content: userContent },
        steps: [],
        finalResponse: { id: `a-${userContent}`, kind: 'assistant', content: assistantContent },
        changes: null,
      };
    }

    function exportMock(turns: ReturnType<typeof makeTurn>[], running = false) {
      const conversationExport = {
        buildModel: jest.fn(async () => ({
          model: {
            meta: {
              title: 'S7',
              sessionId: 7,
              provider: 'claude',
              branch: 'feat/x',
              exportedAt: new Date().toISOString(),
            },
            preamble: [],
            turns,
          },
          running,
        })),
      };
      return { sessions: sessionsMock(), conversationExport };
    }

    it('first call returns full session (delta=false) and sets the cursor', async () => {
      const turns = [makeTurn('hi', 'hello'), makeTurn('bye', 'goodbye')];
      const services = exportMock(turns);
      const ctx = makeCtx(services);

      const res = await readSessionTool.handler(
        { sessionId: 7, precision: 'small', includeChanges: false, includeIds: false },
        ctx,
      );
      expect(res.data).toMatchObject({ delta: false, newTurns: 2, totalTurns: 2 });
      expect((res.data as { markdown: string }).markdown).toContain('## Turn 1');
      expect((res.data as { markdown: string }).markdown).toContain('## Turn 2');
      // Cursor is stored as turn count under the precision-scoped key
      expect(ctx.cursors.get('t', '7:small')).toBe('2');
    });

    it('second call delivers only new turns (delta=true) with correct global turn numbers', async () => {
      const turns = [makeTurn('hi', 'hello')];
      const services = exportMock(turns);
      const ctx = makeCtx(services);

      await readSessionTool.handler(
        { sessionId: 7, precision: 'small', includeChanges: false, includeIds: false },
        ctx,
      );

      // Simulate a new turn appearing
      const newTurn = makeTurn('more', 'ok');
      (services.conversationExport.buildModel as jest.Mock).mockResolvedValue({
        model: {
          meta: { title: 'S7', sessionId: 7, provider: 'claude', branch: 'feat/x', exportedAt: '' },
          preamble: [],
          turns: [...turns, newTurn],
        },
        running: false,
      });

      const second = await readSessionTool.handler(
        { sessionId: 7, precision: 'small', includeChanges: false, includeIds: false },
        ctx,
      );
      expect(second.data).toMatchObject({ delta: true, newTurns: 1, totalTurns: 2 });
      // Turn number must reflect global position (turn 2, not turn 1)
      expect((second.data as { markdown: string }).markdown).toContain('## Turn 2');
      expect((second.data as { markdown: string }).markdown).not.toContain('## Turn 1');
      expect(ctx.cursors.get('t', '7:small')).toBe('2');
    });

    it('returns newTurns=0 with no markdown when nothing is new', async () => {
      const turns = [makeTurn('hi', 'hello')];
      const services = exportMock(turns);
      const ctx = makeCtx(services);

      await readSessionTool.handler(
        { sessionId: 7, precision: 'small', includeChanges: false, includeIds: false },
        ctx,
      );
      const second = await readSessionTool.handler(
        { sessionId: 7, precision: 'small', includeChanges: false, includeIds: false },
        ctx,
      );
      expect(second.data).toMatchObject({ newTurns: 0, totalTurns: 1 });
      expect((second.data as Record<string, unknown>).markdown).toBeUndefined();
    });

    it('changing precision resets the cursor and returns a full read', async () => {
      const turns = [makeTurn('hi', 'hello')];
      const services = exportMock(turns);
      const ctx = makeCtx(services);

      await readSessionTool.handler(
        { sessionId: 7, precision: 'small', includeChanges: false, includeIds: false },
        ctx,
      );
      // Switch to 'full' — different cursor scope, should be a fresh full read
      const res = await readSessionTool.handler(
        { sessionId: 7, precision: 'full', includeChanges: false, includeIds: false },
        ctx,
      );
      expect(res.data).toMatchObject({ delta: false, newTurns: 1, totalTurns: 1 });
    });

    it('throws a ToolError for an unknown session', async () => {
      const services = { sessions: sessionsMock(null), conversationExport: {} };
      await expect(
        readSessionTool.handler(
          { sessionId: 99, precision: 'small', includeChanges: false, includeIds: false },
          makeCtx(services),
        ),
      ).rejects.toBeInstanceOf(ToolError);
    });
  });

  describe('grep_session', () => {
    function exportMock(markdown: string) {
      return {
        sessions: sessionsMock(),
        conversationExport: {
          buildModel: jest.fn(async () => ({
            model: {
              meta: { title: 'S7', sessionId: 7, provider: 'claude', branch: 'feat/x', exportedAt: '' },
              preamble: [],
              // Provide a minimal turns array that will render to the given markdown
              // via a passthrough: we mock renderMarkdown indirectly by providing
              // the model. Since renderMarkdown is a pure function imported from the
              // service, we can't easily stub it here — instead we feed real turns
              // that produce predictable output.
              turns: [],
            },
            running: false,
          })),
        },
      };
    }

    it('returns matches with line numbers and context', async () => {
      const items = [
        { id: 'u1', kind: 'user' as const, content: 'find the needle please', isError: false },
        { id: 'a1', kind: 'assistant' as const, content: 'here is the needle result', isError: false },
      ];
      const model = buildExportModel(items, {
        title: 'S7', sessionId: 7, provider: 'claude', branch: 'feat/x', exportedAt: '',
      });
      const services = {
        sessions: sessionsMock(),
        conversationExport: { buildModel: jest.fn(async () => ({ model, running: false })) },
      };

      const res = await grepSessionTool.handler(
        { sessionId: 7, query: 'needle', precision: 'small', isRegExp: false, caseSensitive: false, contextLines: 1, maxMatches: 10 },
        makeCtx(services),
      );
      const data = res.data as { matchCount: number; matches: { lineNumber: number; line: string }[]; totalLines: number };
      expect(data.matchCount).toBeGreaterThan(0);
      expect(data.matches[0].lineNumber).toBeGreaterThan(0);
      expect(data.matches[0].line.toLowerCase()).toContain('needle');
      expect(data.totalLines).toBeGreaterThan(0);
      expect(res.nextStep).toContain('read_session_range');
    });

    it('returns empty matches when nothing found', async () => {
      const model = buildExportModel(
        [{ id: 'u1', kind: 'user' as const, content: 'hello world', isError: false }],
        { title: 'S7', sessionId: 7, provider: 'claude', branch: 'feat/x', exportedAt: '' },
      );
      const services = {
        sessions: sessionsMock(),
        conversationExport: { buildModel: jest.fn(async () => ({ model, running: false })) },
      };
      const res = await grepSessionTool.handler(
        { sessionId: 7, query: 'xyznotfound', precision: 'small', isRegExp: false, caseSensitive: false, contextLines: 2, maxMatches: 10 },
        makeCtx(services),
      );
      expect((res.data as { matchCount: number }).matchCount).toBe(0);
      expect(res.nextStep).toContain('broader');
    });

    it('throws on invalid regexp', async () => {
      const model = buildExportModel([], { title: 'S7', sessionId: 7, provider: 'claude', branch: 'feat/x', exportedAt: '' });
      const services = {
        sessions: sessionsMock(),
        conversationExport: { buildModel: jest.fn(async () => ({ model, running: false })) },
      };
      await expect(
        grepSessionTool.handler(
          { sessionId: 7, query: '[invalid', precision: 'small', isRegExp: true, caseSensitive: false, contextLines: 2, maxMatches: 10 },
          makeCtx(services),
        ),
      ).rejects.toBeInstanceOf(ToolError);
    });
  });

  describe('read_session_range', () => {
    async function buildServices() {
      const items = Array.from({ length: 5 }, (_, i) => ({
        id: `u${i}`,
        kind: 'user' as const,
        content: `message ${i + 1}`,
        isError: false,
      }));
      const model = buildExportModel(items, {
        title: 'S7', sessionId: 7, provider: 'claude', branch: 'feat/x', exportedAt: '',
      });
      return {
        sessions: sessionsMock(),
        conversationExport: { buildModel: jest.fn(async () => ({ model, running: false })) },
      };
    }

    it('returns the requested line slice with correct metadata', async () => {
      const services = await buildServices();
      const res = await readSessionRangeTool.handler(
        { sessionId: 7, startLine: 1, endLine: 5, precision: 'small' },
        makeCtx(services),
      );
      const data = res.data as { startLine: number; endLine: number; totalLines: number; content: string };
      expect(data.startLine).toBe(1);
      expect(data.endLine).toBe(5);
      expect(data.totalLines).toBeGreaterThan(0);
      expect(data.content.split('\n')).toHaveLength(5);
    });

    it('clamps endLine to document bounds', async () => {
      const services = await buildServices();
      // Use an endLine beyond the document (which is ~30 lines) but within the 200-line cap.
      const res = await readSessionRangeTool.handler(
        { sessionId: 7, startLine: 1, endLine: 150, precision: 'small' },
        makeCtx(services),
      );
      const data = res.data as { endLine: number; totalLines: number };
      expect(data.endLine).toBe(data.totalLines);
      expect(data.totalLines).toBeLessThan(150);
    });

    it('throws when endLine < startLine', async () => {
      const services = await buildServices();
      await expect(
        readSessionRangeTool.handler(
          { sessionId: 7, startLine: 10, endLine: 5, precision: 'small' },
          makeCtx(services),
        ),
      ).rejects.toBeInstanceOf(ToolError);
    });

    it('throws when range exceeds the 200-line cap', async () => {
      const services = await buildServices();
      await expect(
        readSessionRangeTool.handler(
          { sessionId: 7, startLine: 1, endLine: 201, precision: 'small' },
          makeCtx(services),
        ),
      ).rejects.toBeInstanceOf(ToolError);
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
