import { RuntimeBrowserService } from './runtime-browser.service.js';
import type { RuntimeBrowserPool } from './runtime-browser-pool.js';
import type { RuntimeBrowserPersistence } from './runtime-persistence.js';

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
