import { chatWork, legacyActivity } from './desktop-chat-work.js';

const controls = { stopTask: true, stopAgent: true };
const at = (minute: number) =>
  `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`;

describe('desktop chat background work', () => {
  it('lists live work from the authoritative registry, enriched by task and agent records', () => {
    const work = chatWork(
      {
        backgroundWork: [
          {
            id: 'task:agent-1',
            kind: 'subagent',
            label: 'Review retry claims',
            detail: 'old',
            startedAt: at(1),
          },
          {
            id: 'task:shell',
            kind: 'task',
            label: 'pnpm test --watch',
            startedAt: at(2),
          },
          {
            id: 'subagent:codex',
            kind: 'subagent',
            label: 'worker',
            detail: 'Checking\nmore lines',
            startedAt: at(3),
          },
          { id: 'unknown:x', kind: 'task', label: 'ignored' },
        ],
        tasks: [
          {
            taskId: 'agent-1',
            status: 'running',
            canStop: true,
            summary: 'Reading retry.ts',
            usage: { totalTokens: 18400, toolUses: 9 },
          },
          {
            taskId: 'shell',
            status: 'running',
            canStop: false,
            parentTaskId: 'agent-done',
            lastToolName: 'Bash',
          },
          { taskId: 'agent-done', status: 'completed' },
        ],
        subagents: [
          { agentId: 'agent-1', agentType: 'Explore', status: 'started' },
          {
            agentId: 'codex',
            agentType: 'worker',
            status: 'started',
            canStop: true,
          },
        ],
        // A finished task that is not in backgroundWork never counts as running.
      },
      controls,
    );
    expect(work.running).toMatchObject([
      {
        id: 'task:agent-1',
        kind: 'agent',
        label: 'Review retry claims · Explore',
        title: 'Review retry claims',
        role: 'Explore',
        detail: 'Reading retry.ts',
        startedAt: at(1),
        stoppable: true,
        orphaned: false,
        tokens: 18400,
        toolUses: 9,
      },
      {
        id: 'task:shell',
        kind: 'task',
        label: 'pnpm test --watch',
        detail: 'Last used Bash',
        startedAt: at(2),
        stoppable: false,
        orphaned: true,
      },
      {
        id: 'subagent:codex',
        kind: 'agent',
        label: 'worker',
        detail: 'Checking',
        startedAt: at(3),
        stoppable: true,
        orphaned: false,
      },
    ]);
    // A role already present in the label is not repeated as a separate field.
    expect(work.running[2]).not.toHaveProperty('role');
    expect(work.running[1]).not.toHaveProperty('title');
    // Harnesses without the stop operation never advertise a Stop button.
    expect(
      chatWork(
        {
          backgroundWork: [
            { id: 'subagent:codex', kind: 'subagent', label: 'w' },
          ],
          subagents: [{ agentId: 'codex', canStop: true }],
        },
        { stopTask: false, stopAgent: false },
      ).running[0]?.stoppable,
    ).toBe(false);
  });

  it('keeps failures and finished background work but drops routine successes', () => {
    const work = chatWork(
      {
        runPhase: 'idle',
        hooks: [
          {
            hookId: 'ok',
            hookName: 'PreToolUse:Bash',
            hookEvent: 'PreToolUse',
            status: 'success',
            updatedAt: at(9),
          },
          {
            hookId: 'run',
            hookName: 'Stop',
            hookEvent: 'Stop',
            status: 'running',
            updatedAt: at(9),
          },
          {
            hookId: 'bad',
            hookName: 'PostToolUse:Edit',
            hookEvent: 'PostToolUse',
            status: 'error',
            exitCode: 2,
            stderr: 'prettier failed',
            updatedAt: at(8),
          },
        ],
        tasks: [
          {
            taskId: 'bg',
            isBackgrounded: true,
            status: 'completed',
            description: 'Update notes',
            summary: 'Done\nmore',
            endTime: Date.parse(at(7)),
            updatedAt: at(7),
          },
          {
            taskId: 'fg',
            isBackgrounded: false,
            status: 'completed',
            description: 'Foreground',
            updatedAt: at(6),
          },
          {
            taskId: 'fail',
            isBackgrounded: true,
            status: 'failed',
            description: 'Migrate',
            error: 'boom',
            updatedAt: at(5),
          },
          {
            taskId: 'amb',
            isBackgrounded: true,
            ambient: true,
            status: 'completed',
            updatedAt: at(5),
          },
        ],
        subagents: [
          {
            agentId: 'codex',
            agentType: 'worker',
            status: 'stopped',
            completedAt: at(4),
            lastAssistantMessage: 'All green',
          },
        ],
        latestApiRetry: {
          attempt: 2,
          maxRetries: 10,
          errorStatus: 529,
          error: 'Overloaded',
          timestamp: at(3),
        },
        latestCompactBoundary: {
          trigger: 'auto',
          preTokens: 182000,
          postTokens: 41200,
          timestamp: at(2),
        },
        latestToolProgress: {
          toolName: 'Bash',
          elapsedTimeSeconds: 4,
          timestamp: at(9),
        },
      },
      controls,
    );
    expect(
      work.recent.map((event) => [event.kind, event.tone, event.title]),
    ).toEqual([
      ['hook', 'danger', 'PostToolUse:Edit failed'],
      ['finished', 'success', 'Update notes finished'],
      ['finished', 'danger', 'Migrate failed'],
      ['finished', 'success', 'worker finished'],
      ['compaction', 'info', 'Context compacted'],
    ]);
    expect(work.recent[0]?.detail).toBe(
      'PostToolUse · exit 2\nprettier failed',
    );
    expect(work.recent[4]?.detail).toBe('182k → 41.2k tokens · Automatic');
    // Old desktops see only live work and items needing attention.
    expect(legacyActivity(work).map((entry) => entry.label)).toEqual([
      'PostToolUse:Edit failed',
      'Migrate failed',
    ]);
  });

  it('shows a retry only while the run that hit it is still active', () => {
    const raw = {
      latestApiRetry: {
        attempt: 2,
        maxRetries: 10,
        errorStatus: 529,
        error: 'Overloaded',
        timestamp: at(3),
      },
      lastPromptTiming: { startedAt: at(2) },
    };
    expect(chatWork({ ...raw, runPhase: 'running' }, controls).recent).toEqual([
      expect.objectContaining({
        kind: 'retry',
        tone: 'warning',
        title: 'Retrying request · attempt 2 of 10',
        detail: 'HTTP 529 · Overloaded',
      }),
    ]);
    expect(chatWork({ ...raw, runPhase: 'idle' }, controls).recent).toEqual([]);
    expect(
      chatWork(
        { ...raw, runPhase: 'running', lastPromptTiming: { startedAt: at(4) } },
        controls,
      ).recent,
    ).toEqual([]);
  });

  it('bounds lists and ignores malformed runtime data', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `task:${i}`,
      kind: 'task',
      label: 'x'.repeat(500),
      startedAt: 'not a date',
    }));
    const work = chatWork(
      {
        backgroundWork: many,
        hooks: 'nope',
        tasks: null,
        notifications: [{ text: '' }],
      },
      controls,
    );
    expect(work.running).toHaveLength(16);
    expect(work.running[0]?.label.length).toBeLessThanOrEqual(240);
    expect(work.running[0]?.startedAt).toBeNull();
    expect(work.recent).toEqual([]);
    expect(chatWork({}, controls)).toEqual({
      running: [],
      recent: [],
      totalRunning: 0,
    });
  });
  it('preserves interrupted and unavailable outcomes instead of claiming success', () => {
    const work = chatWork(
      {
        subagents: [
          'interrupted',
          'closed',
          'unavailable',
          'error',
          'completed',
        ].map((executionStatus) => ({
          agentId: executionStatus,
          agentType: 'worker',
          status: 'stopped',
          executionStatus,
          timestamp: at(9),
        })),
      },
      controls,
    );
    expect(work.recent.map((event) => [event.title, event.tone])).toEqual([
      ['worker interrupted', 'warning'],
      ['worker closed', 'info'],
      ['worker unavailable', 'warning'],
      ['worker failed', 'danger'],
      ['worker finished', 'success'],
    ]);
  });
  it('includes owned live children without backgroundWork and gates foreground controls', () => {
    const work = chatWork(
      {
        runPhase: 'running',
        subagents: [
          {
            agentId: 'native-child',
            agentType: 'reviewer',
            status: 'started',
            executionStatus: 'waiting',
            isBackgrounded: false,
            canBackground: true,
            canStop: true,
            model: 'native-model',
            timestamp: at(1),
            contextUsage: { totalTokens: 100, maxTokens: 200 },
          },
        ],
      },
      { ...controls, backgroundAgent: true, inspectAgent: true },
    );
    expect(work.running[0]).toMatchObject({
      agentId: 'native-child',
      status: 'waiting',
      background: false,
      inspectable: true,
      canBackground: true,
      context: { tokens: 100, limit: 200, percentage: 50 },
    });
    expect(work.totalRunning).toBe(1);
  });
  it('does not resurrect stale history records as live work after the parent ends', () => {
    const raw = {
      runPhase: 'idle',
      subagents: [
        {
          agentId: 'stale',
          agentType: 'worker',
          status: 'started',
          isBackgrounded: false,
        },
      ],
    };
    expect(chatWork(raw, controls).running).toEqual([]);
    expect(
      chatWork(
        {
          ...raw,
          backgroundWork: [
            { id: 'subagent:stale', kind: 'subagent', label: 'Actually live' },
          ],
        },
        controls,
      ).running[0]?.background,
    ).toBe(true);
  });
});
