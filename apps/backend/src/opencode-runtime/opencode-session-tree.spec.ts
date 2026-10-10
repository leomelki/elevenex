/* eslint-disable @typescript-eslint/require-await */
import type { Session } from '@opencode-ai/sdk/v2/client';
import type { OpenCodeClient } from './opencode-client.js';
import { OpenCodeSessionTree } from './opencode-session-tree.js';

const session = (id: string, parentID?: string): Session => ({
  id,
  parentID,
  slug: id,
  title: id,
  directory: '/repo',
  projectID: 'project',
  version: '1',
  time: { created: 1, updated: 1 },
});
const signal = () => new AbortController().signal;

describe('OpenCode descendant ownership', () => {
  it('resolves out-of-order grandchildren and coalesces ancestor requests', async () => {
    const tree = new OpenCodeSessionTree();
    const get = jest.fn(async ({ sessionID }: { sessionID: string }) => ({
      data: session(sessionID, sessionID === 'grandchild' ? 'child' : 'root'),
    }));
    const client = { session: { get } } as unknown as OpenCodeClient;
    expect(
      await Promise.all([
        tree.resolve('root', 'grandchild', client, signal()),
        tree.resolve('root', 'grandchild', client, signal()),
      ]),
    ).toEqual([true, true]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(tree.owns('root', 'grandchild')).toBe(true);
    expect(tree.descendants('root').map((child) => child.id)).toEqual([
      'child',
      'grandchild',
    ]);
  });
  it('rejects foreign sessions, cycles, and cancellation', async () => {
    const tree = new OpenCodeSessionTree();
    const get = jest.fn(async ({ sessionID }: { sessionID: string }) => ({
      data: session(
        sessionID,
        sessionID === 'a' ? 'b' : sessionID === 'b' ? 'a' : undefined,
      ),
    }));
    const client = { session: { get } } as unknown as OpenCodeClient;
    expect(await tree.resolve('root', 'foreign', client, signal())).toBe(false);
    expect(await tree.resolve('root', 'a', client, signal())).toBe(false);
    expect(tree.descendants('root')).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    expect(await tree.resolve('root', 'child', client, controller.signal)).toBe(
      false,
    );
    expect(get).toHaveBeenCalledTimes(3);
  });
  it('restores all nesting levels and removes stale descendants', async () => {
    const tree = new OpenCodeSessionTree();
    const children = jest.fn(async ({ sessionID }: { sessionID: string }) => ({
      data:
        sessionID === 'root'
          ? [session('child')]
          : sessionID === 'child'
            ? [session('grandchild')]
            : [],
    }));
    const client = { session: { children } } as unknown as OpenCodeClient;
    await tree.restore('root', client, signal());
    expect(tree.owns('root', 'grandchild')).toBe(true);
    children.mockResolvedValue({ data: [] });
    await tree.restore('root', client, signal());
    expect(tree.descendants('root')).toEqual([]);
    expect(tree.owns('root', 'grandchild')).toBe(false);
  });
  it('does not overwrite child metadata arriving during recovery', async () => {
    const tree = new OpenCodeSessionTree();
    tree.track(session('child', 'root'));
    let finish!: (result: { data: Session[] }) => void;
    const snapshot = new Promise<{ data: Session[] }>((resolve) => {
      finish = resolve;
    });
    const children = jest.fn(({ sessionID }: { sessionID: string }) =>
      sessionID === 'root' ? snapshot : Promise.resolve({ data: [] }),
    );
    const restoring = tree.restore(
      'root',
      { session: { children } } as unknown as OpenCodeClient,
      signal(),
    );
    tree.track({ ...session('child', 'root'), title: 'Updated live' });
    finish({ data: [session('child', 'root')] });
    await restoring;
    expect(tree.descendants('root')[0].title).toBe('Updated live');
  });
});
