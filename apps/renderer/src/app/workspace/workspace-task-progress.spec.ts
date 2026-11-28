import { describe, expect, it } from 'vitest';
import type { WorkspaceTask } from '@elevenex/shared';
import { setupElapsed, workspaceSetupSteps, workspaceTaskSignal } from './workspace-task-progress';

const task: WorkspaceTask = { id: 1, projectId: 2, repoId: 3, name: 'Task', branchName: 'refs/heads/feature/x', stage: 'active', state: 'ready', archivedAt: null, updatedAt: '' };

describe('workspace task progress', () => {
  it('reports nothing for a ready or closed workspace', () => {
    expect(workspaceTaskSignal(task)).toBeNull();
    expect(workspaceTaskSignal({ ...task, state: 'preparing', archivedAt: 'now' })).toBeNull();
    expect(workspaceSetupSteps({ ...task, setupStep: 'checkout' })).toBeNull();
  });

  it('follows the backend order and never invents a step for older runtimes', () => {
    expect(workspaceSetupSteps({ ...task, state: 'preparing' })).toBeNull();
    expect(workspaceSetupSteps({ ...task, state: 'preparing', setupStep: 'queued' })?.map(step => step.state)).toEqual(['active', 'todo', 'todo']);
    expect(workspaceSetupSteps({ ...task, state: 'preparing', setupStep: 'sessions' })?.map(step => step.state)).toEqual(['done', 'done', 'active']);
    expect(workspaceSetupSteps({ ...task, state: 'preparing', setupStep: 'checkout' })?.[1]?.detail).toBe('Checking out feature/x');
    expect(workspaceSetupSteps({ ...task, state: 'failed', setupStep: 'fetching' })?.map(step => step.state)).toEqual(['failed', 'todo', 'todo']);
  });

  it('summarizes every lifecycle state the open session or sidebar can see', () => {
    expect(workspaceTaskSignal({ ...task, state: 'preparing' })).toMatchObject({ tone: 'working', description: 'Setting up workspace' });
    expect(workspaceTaskSignal({ ...task, state: 'preparing', setupStep: 'waiting' })?.description).toContain('waiting for the repository');
    expect(workspaceTaskSignal({ ...task, state: 'failed', setupStep: 'checkout' })).toMatchObject({ tone: 'attention', label: 'Needs setup' });
    expect(workspaceTaskSignal({ ...task, state: 'failed', setupIssue: { code: 'other', message: 'x', canUseSnapshot: false, closeFailed: true } }))
      .toMatchObject({ tone: 'attention', label: 'Close failed' });
    expect(workspaceTaskSignal({ ...task, state: 'finishing' })).toMatchObject({ tone: 'working', label: 'Closing' });
    expect(workspaceTaskSignal({ ...task, state: 'releasing' })).toMatchObject({ tone: 'working', label: 'Releasing' });
    expect(workspaceTaskSignal({ ...task, state: 'released' })).toMatchObject({ tone: 'quiet', label: 'No workspace' });
  });

  it('formats elapsed time after the first few seconds', () => {
    expect(setupElapsed(4_999)).toBeUndefined();
    expect(setupElapsed(65_000)).toBe('1:05');
    expect(setupElapsed(Number.NaN)).toBeUndefined();
  });
});
