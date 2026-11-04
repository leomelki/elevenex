import { RuntimeBrowserService } from './runtime-browser.service.js';
import type { RuntimeBrowserPool } from './runtime-browser-pool.js';
import type { RuntimeBrowserPersistence } from './runtime-persistence.js';
import { RuntimeBrowserTask } from './runtime-task.js';
import { randomUUID } from 'node:crypto';

it('orders existing tabs atomically, preserves selection and ownership, and saves that order', async () => {
  const persistence = { read: async () => null, save: async () => undefined, flush: async () => undefined };
  const pool = { isApplicationPort: () => false } as unknown as RuntimeBrowserPool;
  const service = new RuntimeBrowserService(pool, persistence as unknown as RuntimeBrowserPersistence);
  try {
    const { token } = await service.connect(1, 'client', 'identity');
    const task = service.viewer(1, token);
    task.restore({ active: 1, tabs: ['one', 'two', 'three'].map(name => ({ url: `https://${name}.example/`, width: 'full', by: 'you', agentSessionId: null })) });
    const initial = task.state();
    const [one, two, three] = initial.tabs;
    expect(initial.canReorder).toBe(true);
    let state = await task.command({ kind: 'move-tab', tabId: three.id, beforeTabId: one.id });
    expect(state.tabs.map(tab => tab.id)).toEqual([three.id, one.id, two.id]);
    expect(state.active).toBe(initial.active);
    expect(state.tabs.find(tab => tab.id === three.id)).toEqual(three);
    await expect(task.command({ kind: 'move-tab', tabId: two.id, beforeTabId: randomUUID() })).rejects.toThrow();
    expect(task.state().tabs.map(tab => tab.id)).toEqual(state.tabs.map(tab => tab.id));
    state = await task.command({ kind: 'move-tab', tabId: three.id, beforeTabId: null });
    expect(state.tabs.map(tab => tab.id)).toEqual([one.id, two.id, three.id]);
    await task.command({ kind: 'move-tab', tabId: one.id, beforeTabId: one.id });
    const restored = new RuntimeBrowserTask(1, pool, 'other');
    restored.restore(task.saved());
    expect(restored.state().tabs.map(tab => tab.url)).toEqual(state.tabs.map(tab => tab.url));
    expect(restored.state().tabs.find(tab => tab.id === restored.active)?.url).toBe(two.url);
    await restored.destroy();
  } finally { await service.onModuleDestroy(); }
});

it('orders layout lanes independently and rejects expired viewer tokens', async () => {
  const persistence = { read: async () => null, save: async () => undefined, flush: async () => undefined };
  // No Chromium starts for blank tabs; this tests the service lease boundary.
  const service = new RuntimeBrowserService({} as RuntimeBrowserPool, persistence as unknown as RuntimeBrowserPersistence);
  try {
    const { token } = await service.connect(1, 'client', 'identity');
    const task = service.viewer(1, token);
    const state = await task.command({ kind: 'new-tab' });
    const tabId = state.active!;
    expect(service.layoutViewer(1, token, 100)).toBe(task);
    expect(service.layoutViewer(1, token, 1, tabId)).toBe(task);
    expect(service.layoutViewer(1, token, 1, tabId)).toBeNull();
    expect(service.layoutViewer(1, token, 99)).toBeNull();
    expect(() => service.layoutViewer(1, token, 2, 'closed-tab')).toThrow();
    const replacement = await service.connect(1, 'client', 'identity');
    expect(() => service.layoutViewer(1, token, 101)).toThrow();
    expect(service.layoutViewer(1, replacement.token, 0, tabId)).toBe(task);
  } finally { await service.onModuleDestroy(); }
});
