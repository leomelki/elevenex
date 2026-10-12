import {
  mergeClaudeTask,
  mergeClaudeSubagent,
  retainClaudeTasks,
  taskSubagent,
} from './claude-subagents.js';
import type { ClaudeTaskState } from './claude-runtime.types.js';

const task = (
  status: ClaudeTaskState['status'] = 'running',
): ClaudeTaskState => ({
  taskId: 'worker',
  runId: '001',
  status,
  updatedAt: '2026-10-12T10:00:00Z',
});
describe('Claude native task state', () => {
  it('does not revive a completed run from metadata or late progress', () => {
    const done = task('completed');
    expect(
      mergeClaudeTask(done, {
        taskId: 'worker',
        description: 'Renamed',
        updatedAt: 'later',
      }).status,
    ).toBe('completed');
    expect(
      mergeClaudeTask(done, {
        taskId: 'worker',
        status: 'running',
        updatedAt: 'later',
      }).status,
    ).toBe('completed');
  });
  it('opens a newer run but ignores late events from an earlier run', () => {
    const resumed = mergeClaudeTask(
      task('completed'),
      { taskId: 'worker', runId: '002', status: 'running', updatedAt: 'new' },
      true,
    );
    expect(resumed).toMatchObject({
      status: 'running',
      runId: '002',
      startedAt: 'new',
    });
    expect(
      mergeClaudeTask(resumed, {
        taskId: 'worker',
        runId: '001',
        status: 'completed',
        updatedAt: 'later',
      }),
    ).toBe(resumed);
  });
  it('retains every live worker independently of settled history', () => {
    const tasks = [
      ...Array.from({ length: 250 }, (_, i) => ({
        ...task('completed'),
        taskId: `done-${i}`,
      })),
      ...Array.from({ length: 100 }, (_, i) => ({
        ...task(),
        taskId: `live-${i}`,
      })),
    ];
    const retained = retainClaudeTasks(
      tasks,
      (item) => item.status === 'running',
    );
    expect(retained).toHaveLength(300);
    expect(retained.filter((item) => item.status === 'running')).toHaveLength(
      100,
    );
  });
  it('enriches tasks from native assignments and keeps ancestry and outcome', () => {
    expect(
      taskSubagent(
        {
          ...task('failed'),
          taskType: 'local_agent',
          parentTaskId: 'parent',
          toolUseId: 'dispatch',
          usage: { totalTokens: 400, toolUses: 2, durationMs: 1000 },
        },
        undefined,
        {
          name: 'Reviewer',
          prompt: 'Review the change',
          subagent_type: 'code-reviewer',
          model: 'sonnet',
        },
      ),
    ).toMatchObject({
      agentId: 'worker',
      parentAgentId: 'parent',
      parentToolUseId: 'dispatch',
      displayName: 'Reviewer',
      status: 'stopped',
      executionStatus: 'error',
      prompt: 'Review the change',
      model: 'sonnet',
    });
  });
  it('merges hook enrichment without dropping task and display metadata', () => {
    const current = taskSubagent(task(), undefined, {
      name: 'Reviewer',
      prompt: 'Review',
    });
    expect(
      mergeClaudeSubagent(current, {
        agentId: 'worker',
        agentType: 'reviewer',
        status: 'started',
        timestamp: 'later',
        transcriptPath: '/child.jsonl',
      }),
    ).toMatchObject({
      taskId: 'worker',
      displayName: 'Reviewer',
      prompt: 'Review',
      transcriptPath: '/child.jsonl',
    });
  });
});
