import { describe, expect, it } from 'vitest';
import {
  buildElevenexToolView,
  ELEVENEX_TOOL_META,
  elevenexEnvelope,
  elevenexLink,
  elevenexToolName,
} from './elevenex-tool-view';
import { describeAgentTool, resultSummary } from './agent-tool-format';

const call = (tool: string, args = {}) => ({ toolName: `mcp__elevenex__${tool}`, toolInput: args });
const result = (data: unknown, extra = {}) => ({ content: JSON.stringify({ data, ...extra }) });
describe('Elevenex chat receipts', () => {
  it('reports saving a command independently of its previous failed run', () => {
    expect(
      buildElevenexToolView(
        call('set_action'),
        result({
          actionId: 9,
          command: 'pnpm test',
          status: 'failed',
          lastExitCode: 1,
          created: false,
          updated: true,
        }),
      ),
    ).toMatchObject({
      summary: { text: 'Command saved', tone: 'ok' },
      content: 'pnpm test',
      contentLabel: 'Saved command',
    });
  });
  it('shows failed and stopped commands without applying task finish semantics', () => {
    const failed = buildElevenexToolView(
      call('poll_action_status'),
      result({
        actionId: 9,
        status: 'failed',
        exitCode: 1,
        finishedAt: 'today',
        outputTail: 'Tests failed',
      }),
    );
    expect(failed).toMatchObject({
      summary: { text: 'Command failed', tone: 'error' },
      content: 'Tests failed',
      notice: '',
    });
    expect(
      buildElevenexToolView(
        call('poll_action_status'),
        result({ status: 'stopped', finishedAt: 'today' }),
      )?.summary,
    ).toEqual({ text: 'Command stopped', tone: 'warn' });
    expect(
      buildElevenexToolView(
        call('poll_action_status'),
        result({ status: 'success', exitCode: 0, finishedAt: 'today' }),
      )?.summary,
    ).toEqual({ text: 'Command succeeded', tone: 'ok' });
  });
  it('renders actual search and transcript-match fields', () => {
    expect(
      buildElevenexToolView(
        call('text_search'),
        result({
          matches: [{ path: 'src/auth.ts', lineNumber: 42, lineText: 'throw new Error()' }],
        }),
      )?.rows[0],
    ).toMatchObject({ title: 'src/auth.ts', detail: 'line 42 · throw new Error()' });
    expect(
      buildElevenexToolView(
        call('grep_session'),
        result({
          matches: [{ lineNumber: 12, line: 'Cannot connect', context: '>>> Cannot connect' }],
        }),
      )?.rows[0],
    ).toMatchObject({ title: 'Line 12', detail: 'line 12 · >>> Cannot connect' });
  });
  it('shows blocked diffs and completion summaries', () => {
    expect(
      buildElevenexToolView(
        call('change_review'),
        result({ blocked: true, reason: 'Too many files', totalFiles: 10000 }),
      ),
    ).toMatchObject({
      summary: { tone: 'warn' },
      notice: 'Too many files',
      fields: [{ label: 'Changed files', value: '10000' }],
    });
    expect(
      buildElevenexToolView(
        call('poll_session_status'),
        result({ status: 'completed', transcriptSummary: 'Refactor completed' }),
      )?.content,
    ).toBe('Refactor completed');
    expect(
      buildElevenexToolView(
        call('change_review'),
        result({
          totals: { files: 1, additions: 3, deletions: 2 },
          files: [{ path: 'auth.ts', status: 'M', additions: 3, deletions: 2 }],
        }),
      )?.rows[0],
    ).toMatchObject({ detail: 'M · +3 · −2' });
  });
  it('distinguishes a pending answer from completion and exposes model IDs', () => {
    expect(
      buildElevenexToolView(call('ask_session'), result({ running: true, forkId: 99 }))?.summary,
    ).toEqual({ text: 'Answer pending', tone: 'warn' });
    expect(
      buildElevenexToolView(
        call('get_session_config'),
        result({ models: [{ id: 'provider/model', name: 'Model name' }] }),
      )?.rows[0],
    ).toMatchObject({ title: 'Model name', detail: 'provider/model' });
  });
  const envelope = { data: { taskId: 9, name: 'Fix auth', state: 'ready' }, deepLink: '/tasks/9' };
  it.each([
    envelope,
    JSON.stringify(envelope),
    [{ type: 'text', text: JSON.stringify(envelope) }],
    { structuredContent: envelope, content: [{ type: 'text', text: JSON.stringify(envelope) }] },
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      details: envelope,
    }),
  ])('unwraps provider results without depending on a particular transport', (content) => {
    expect(elevenexEnvelope(content)).toEqual(envelope);
    expect(buildElevenexToolView(call('get_task'), { content })).toMatchObject({
      summary: { text: 'Ready', tone: 'ok' },
      target: 'Fix auth',
      link: '/tasks/9',
    });
  });
  it('recognizes OpenCode names and Codex nested arguments', () => {
    expect(elevenexToolName({ toolName: 'elevenex_get_task' })).toBe('get_task');
    expect(
      describeAgentTool({
        toolName: 'MCP',
        toolKind: 'mcp',
        toolInput: {
          server: 'elevenex',
          tool: 'create_task',
          arguments: { name: 'Fix auth', branchName: 'fix/auth' },
        },
      }),
    ).toMatchObject({ verb: 'Create task', target: 'Fix auth' });
  });
  it('distinguishes accepted setup from actual readiness and completion', () => {
    expect(
      buildElevenexToolView(
        call('create_task'),
        result({ taskId: 9, state: 'preparing', preparationStage: 'preparing_checkout' }),
      ),
    ).toMatchObject({
      summary: { text: 'Preparing', tone: 'warn' },
      notice: expect.stringContaining('Coding work has not started'),
    });
    expect(
      buildElevenexToolView(
        call('finish_task'),
        result({ taskId: 9, state: 'ready', finishedAt: 'today', linkStatus: 'unlinked' }),
      ),
    ).toMatchObject({
      summary: { text: 'Finished' },
      notice: expect.stringContaining('history are preserved'),
    });
    expect(
      buildElevenexToolView(
        call('await_task_ready'),
        result({ state: 'preparing', timedOut: true }),
      ),
    ).toMatchObject({
      summary: { tone: 'warn' },
      notice: expect.stringContaining('continues in the background'),
    });
  });
  it('shows an execution failure even after an approved permission request', () => {
    const failed = {
      content: JSON.stringify({
        error: { code: 'self_target_not_allowed', message: 'Cannot finish the calling task.' },
      }),
      isError: true,
    };
    expect(buildElevenexToolView(call('finish_task'), failed)).toMatchObject({
      toolFailed: true,
      summary: { tone: 'error' },
      error: { remediation: expect.stringContaining('after the current agent turn') },
    });
    expect(
      resultSummary(
        'mcp',
        failed,
        { decisionLabel: 'Approved', decisionTone: 'ok' } as never,
        call('finish_task'),
      )?.tone,
    ).toBe('error');
  });
  it('shows recovery choices for a successfully observed failed task', () => {
    const view = buildElevenexToolView(
      call('get_task'),
      result({
        taskId: 10,
        state: 'failed',
        error: {
          code: 'branch_in_use',
          message: 'Branch in use.',
          existingTaskId: 9,
          canSnapshot: true,
        },
      }),
    );
    expect(view).toMatchObject({
      toolFailed: false,
      error: { remediation: expect.stringContaining('independent snapshot') },
    });
    expect(view?.error?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Existing task', link: '/tasks/9' }),
        expect.objectContaining({ label: 'Alternative' }),
      ]),
    );
  });
  it('bounds lists while preserving navigable IDs and the presence of more results', () => {
    const tasks = Array.from({ length: 100 }, (_, taskId) => ({
      taskId: taskId + 1,
      name: `Task ${taskId + 1}`,
      state: 'ready',
    }));
    const view = buildElevenexToolView(call('list_tasks'), result({ tasks, nextCursor: 100 }));
    expect(view?.rows).toHaveLength(20);
    expect(view?.rows[0]).toMatchObject({ title: 'Task 1', link: '/tasks/1' });
    expect(view?.more).toBe(true);
    expect(buildElevenexToolView(call('find_branches'), result({ branches: [] }))?.listEmpty).toBe(
      true,
    );
  });
  it('keeps zero-process finish previews separate from empty search results', () => {
    const view = buildElevenexToolView(
      call('preview_finish_task'),
      result({ agents: 0, terminals: 0, actions: 0 }),
    );
    expect(view?.summary).toEqual({ text: '0 running processes', tone: 'ok' });
    expect(view?.listEmpty).toBe(false);
    expect(view?.fields).toHaveLength(3);
  });
  it('reports list counts separately from lifecycle filters and archived conversations', () => {
    const view = buildElevenexToolView(
      call('list_tasks'),
      result({ state: 'active', tasks: [{ taskId: 9, state: 'ready' }] }),
    );
    expect(view?.summary).toEqual({ text: '1 task', tone: 'neutral' });
    const conversations = buildElevenexToolView(
      call('find_sessions'),
      result({ sessions: [{ sessionId: 42, archived: true }] }),
    );
    expect(conversations?.rows[0].status?.text).toBe('Archived');
  });
  it('shows staged text and makes clear that saving a draft did not send a prompt', () => {
    expect(
      buildElevenexToolView(
        call('set_task_draft', { taskId: 9, text: 'Review the changes' }),
        result({ taskId: 9, saved: true }),
      ),
    ).toMatchObject({
      content: 'Review the changes',
      notice: 'Saved to the composer. No prompt was sent.',
    });
  });
  it('does not claim completion before a response or change third-party MCP rendering', () => {
    expect(buildElevenexToolView(call('preview_finish_task'), null)?.summary).toBeNull();
    expect(
      buildElevenexToolView({ toolName: 'mcp__other__get_task' }, result({ state: 'ready' })),
    ).toBeNull();
    expect(elevenexLink('javascript:alert(1)')).toBeUndefined();
    expect(elevenexLink('//example.test/tasks/9')).toBeUndefined();
    expect(elevenexLink('/sessions/42?panel=changes')).toBe('/sessions/42?panel=changes');
  });
  it('names task operations and retains historical worktree receipts', () => {
    for (const name of [
      'move_task',
      'await_task_ready',
      'read_task_draft',
      'open_task_session',
      'create_task',
      'rename_session',
      'unarchive_session',
      'find_branches',
      'read_scratchpad',
      'create_worktree',
    ])
      expect(ELEVENEX_TOOL_META[name]).toBeDefined();
  });
});
