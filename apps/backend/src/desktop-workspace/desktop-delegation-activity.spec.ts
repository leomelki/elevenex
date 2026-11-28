import { DesktopDelegationActivity } from './desktop-delegation-activity.js';
import { sessionAgentPrompt } from '../sessions/session-agent-message.js';

describe('lightweight delegated activity', () => {
  it('coalesces progress bursts, publishes decisions promptly and releases pending work', () => {
    jest.useFakeTimers();
    const activity = new DesktopDelegationActivity();
    const updates = jest.fn();
    const dispose = activity.observe(updates);
    try {
      const sessionId = 5;
      activity.update({ type: 'run_state', payload: { sessionId } }, undefined, 'running', true);
      expect(updates).toHaveBeenLastCalledWith(5, true);
      updates.mockClear();
      for (let index = 0; index < 24; index++) {
        const payload = { sessionId, item: { id: String(index), kind: 'tool_use', toolKind: 'read', toolInput: { file_path: 'src/' + index + '.ts' } } };
        activity.update({ type: 'tool_use', payload }, 'running', undefined, false);
      }
      const duplicate = { sessionId, item: { id: '0', kind: 'tool_use' } };
      activity.update({ type: 'tool_use', payload: duplicate }, 'running', undefined, false);
      jest.advanceTimersByTime(599);
      expect(updates).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(updates).toHaveBeenCalledTimes(1);
      expect(activity.get(5)).toMatchObject({ detail: 'Reading src/23.ts', toolUses: 24 });

      const payload = { sessionId, pendingPermissionRequest: { description: 'Choose whether to run tests' } };
      activity.update({ type: 'run_state', payload }, 'running', 'attention', true);
      expect(updates).toHaveBeenLastCalledWith(5, true);
      expect(activity.get(5)?.detail).toBe('Choose whether to run tests');
      activity.interrupted(5);
      expect(activity.get(5)?.interrupted).toBe(true);
      dispose();
    } finally {
      activity.dispose();
      expect(jest.getTimerCount()).toBe(0);
      jest.useRealTimers();
    }
  });

  it('recovers queued delivery from snapshots and ends a turn even after hooks clear its activity', () => {
    const activity = new DesktopDelegationActivity();
    const sessionId = 9;
    const messageId = '00000000-0000-4000-8000-000000000001';
    try {
      activity.update({ type: 'run_state', payload: { sessionId } }, undefined, 'running', true);
      const payload = { sessionId, liveItems: [{ kind: 'user', content: sessionAgentPrompt('Review', { sessionId: 2 }, 'message', messageId) }] };
      activity.update({ type: 'runtime_snapshot', payload }, undefined, 'idle', false);
      expect(activity.get(sessionId)).toMatchObject({ deliveries: [messageId], endedAt: expect.any(String) });
    } finally {
      activity.dispose();
    }
  });
});
