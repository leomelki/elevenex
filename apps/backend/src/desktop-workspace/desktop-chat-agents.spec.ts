import { readChatAgent } from './desktop-chat-agents.js';
import type { AgentSubagentHistoryPayload } from '../agent-runtime/agent-runtime.types.js';

const snapshot = (): AgentSubagentHistoryPayload => ({
  subagent: {
    agentId: 'child',
    agentType: 'worker',
    status: 'started',
    timestamp: '2026-11-11T10:00:00Z',
  },
  transcriptAvailable: true,
  history: Array.from({ length: 170 }, (_, n) => ({
    id: `message-${n}`,
    kind: 'assistant',
    content: `Entry ${n}`,
    timestamp: '',
  })),
});
describe('desktop child transcript', () => {
  it('retains the task title and agent identity when opening finished work without a live row', async () => {
    const value = snapshot();
    value.subagent = {
      ...value.subagent,
      taskTitle: 'Review retry handling',
      displayName: 'James',
      agentType: 'reviewer',
    };
    expect(
      await readChatAgent(
        { getSubagentHistory: async () => value },
        1,
        'child',
      ),
    ).toMatchObject({
      title: 'Review retry handling',
      agentName: 'James',
      role: 'reviewer',
      label: 'James',
    });
  });
  it('returns bounded, non-overlapping history windows without exposing paths', async () => {
    const getSubagentHistory = jest.fn(async () => snapshot());
    const provider = { getSubagentHistory };
    const tail = await readChatAgent(provider, 1, 'child');
    expect(tail.items).toHaveLength(80);
    expect(tail.items[0].id).toBe('message-90');
    const earlier = await readChatAgent(provider, 1, 'child', tail.before!);
    expect(earlier.items).toHaveLength(80);
    expect(earlier.items.at(-1)?.id).toBe('message-89');
    const first = await readChatAgent(provider, 1, 'child', earlier.before!);
    expect(first.items).toHaveLength(10);
    expect(first.before).toBeNull();
    expect(tail).not.toHaveProperty('transcriptPath');
  });
  it('rejects invalid identities, cursors and provider identity mismatches', async () => {
    const getSubagentHistory = jest.fn(async () => snapshot());
    await expect(
      readChatAgent({ getSubagentHistory }, 1, '../other'),
    ).rejects.toThrow();
    await expect(
      readChatAgent({ getSubagentHistory }, 1, 'child', 'bad'),
    ).rejects.toThrow();
    expect(getSubagentHistory).not.toHaveBeenCalled();
    await expect(
      readChatAgent({ getSubagentHistory }, 1, 'other'),
    ).rejects.toThrow('identity');
    getSubagentHistory.mockRejectedValueOnce(
      new Error('Not owned by this session'),
    );
    await expect(
      readChatAgent({ getSubagentHistory }, 1, 'child'),
    ).rejects.toThrow('Not owned');
  });
});
