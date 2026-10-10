/* eslint-disable @typescript-eslint/require-await */
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { createOpenCodeV1Client } from './opencode-v1-client.js';

describe('OpenCode legacy protocol extensions', () => {
  it.each(['selected', 'agent', 'project', 'provider'])(
    'resolves the %s compaction model',
    async (source) => {
      const summarize = jest.fn();
      const models = {
        selected: { providerID: 'selected', modelID: 'm' },
        agent: { providerID: 'agent', modelID: 'm' },
        project: { providerID: 'project', modelID: 'm' },
        provider: { providerID: 'provider', modelID: 'm' },
      };
      const client = createOpenCodeV1Client({
        session: { summarize },
        app: {
          agents: async () => ({
            data: [
              {
                name: 'reviewer',
                model: source === 'agent' ? models.agent : undefined,
              },
            ],
          }),
        },
        config: {
          get: async () => ({
            data: { model: source === 'project' ? 'project/m' : undefined },
          }),
        },
        provider: {
          list: async () => ({
            data: { connected: ['provider'], default: { provider: 'm' } },
          }),
        },
      } as unknown as OpencodeClient);
      await client.compact!('s', {
        agent: 'reviewer',
        model: source === 'selected' ? models.selected : undefined,
      });
      expect(summarize).toHaveBeenCalledWith({
        sessionID: 's',
        ...models[source as keyof typeof models],
      });
    },
  );
  it('moves a session without moving working-tree changes', async () => {
    const moveSession = jest.fn();
    const client = createOpenCodeV1Client({
      experimental: { controlPlane: { moveSession } },
    } as unknown as OpencodeClient);
    await client.moveSession!('s', '/worktree');
    expect(moveSession).toHaveBeenCalledWith({
      sessionID: 's',
      destination: { directory: '/worktree' },
      moveChanges: false,
    });
  });
});
