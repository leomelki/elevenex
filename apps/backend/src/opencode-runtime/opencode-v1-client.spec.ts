/* eslint-disable @typescript-eslint/require-await */
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { createOpenCodeV1Client } from './opencode-v1-client.js';

describe('OpenCode legacy protocol extensions', () => {
  it('steers with an asynchronous native prompt and the active turn selection', async () => {
    const promptAsync = jest.fn().mockResolvedValue({});
    const message = jest.fn(async ({ messageID }: { messageID: string }) => ({ data: { info: { id: messageID } } }));
    const client = createOpenCodeV1Client({
      session: { promptAsync, message },
    } as unknown as OpencodeClient);
    const selection = { model: { providerID: 'test', modelID: 'm' }, agent: 'plan', variant: 'high' };
    const signal = new AbortController().signal;
    const receipt = await client.steerPrompt!('s', 'Check the failing test', selection, { signal });
    expect(promptAsync).toHaveBeenCalledWith({
      sessionID: 's', messageID: expect.stringMatching(/^msg_[0-9a-f]{40}$/), ...selection, parts: [{ type: 'text', text: 'Check the failing test' }],
    }, { signal });
    await expect(receipt && receipt(signal)).resolves.toBe(true);
    expect(message).toHaveBeenCalledWith({
      sessionID: 's', messageID: promptAsync.mock.calls[0][0].messageID,
    }, { signal, throwOnError: false });
  });
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
