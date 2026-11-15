import type { WorkspaceSession } from '@elevenex/shared';
import { workspaceSessionStatus } from './workspace.models';

describe('workspace session activity compatibility', () => {
  const session = (status: string): WorkspaceSession => ({
    id: 1, taskId: 2, repoId: 3, name: 'Existing chat', provider: 'codex', status, updatedAt: '',
  });
  it.each(['idle', 'active', 'completed', 'done', 'stopped', 'archived'])(
    'keeps an inactive %s conversation out of the queue', status => {
      expect(workspaceSessionStatus(session(status))).toBe('done');
    },
  );
  it.each(['created', 'queued'])(
    'keeps genuinely unstarted or queued %s conversations dotted', status => {
      expect(workspaceSessionStatus(session(status))).toBe('queued');
    },
  );
  it('retains explicit live, unseen and failed activity', () => {
    for (const status of ['running', 'attention', 'review', 'failed'] as const)
      expect(workspaceSessionStatus(session(status))).toBe(status);
  });
});
