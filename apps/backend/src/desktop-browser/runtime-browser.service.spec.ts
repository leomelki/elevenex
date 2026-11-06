import { RuntimeBrowserService } from './runtime-browser.service.js';
import type { RuntimeBrowserPool } from './runtime-browser-pool.js';
import type { RuntimeBrowserPersistence } from './runtime-persistence.js';
import { RuntimeBrowserTask } from './runtime-task.js';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';

it('serializes competing task evictions and releases each old owner only once', async () => {
  let releaseSave!: () => void;
  let markSaving!: () => void;
  const saving = new Promise<void>(resolve => { markSaving = resolve; });
  const gate = new Promise<void>(resolve => { releaseSave = resolve; });
  const persistence = { read: async () => null, save: async () => { markSaving(); await gate; }, flush: async () => undefined };
  const service = new RuntimeBrowserService({} as RuntimeBrowserPool, persistence as unknown as RuntimeBrowserPersistence);
  try {
    const one = await service.prepare(1, 'one');
    const two = await service.prepare(2, 'two');
    await service.prepare(3, 'three');
    await service.prepare(4, 'four');
    const destroyOne = jest.spyOn(one, 'destroy'), destroyTwo = jest.spyOn(two, 'destroy');
    const fifth = service.prepare(5, 'five');
    await saving;
    const sixth = service.prepare(6, 'six');
    releaseSave();
    await Promise.all([fifth, sixth]);
    expect(destroyOne).toHaveBeenCalledTimes(1);
    expect(destroyTwo).toHaveBeenCalledTimes(1);
  } finally { releaseSave(); await service.onModuleDestroy(); }
});

it('does not install or return an owner after shutdown starts during preparation', async () => {
  let releaseRead!: () => void;
  let markReading!: () => void;
  const reading = new Promise<void>(resolve => { markReading = resolve; });
  const pendingRead = new Promise<null>(resolve => { releaseRead = () => resolve(null); });
  const persistence = { read: async () => { markReading(); return pendingRead; }, save: jest.fn(async () => undefined), flush: async () => undefined };
  const service = new RuntimeBrowserService({} as RuntimeBrowserPool, persistence as unknown as RuntimeBrowserPersistence);
  const opening = service.connect(1, 'viewer', 'identity');
  await reading;
  const stopped = service.onModuleDestroy();
  const rejected = expect(opening).rejects.toThrow();
  releaseRead();
  await rejected;
  await stopped;
  expect(persistence.save).not.toHaveBeenCalled();
  expect(service.active(1)).toBeNull();
  await expect(service.prepare(2, 'other')).rejects.toThrow();
});

it('rejects malformed multibyte viewer tokens as unauthorized', async () => {
  const persistence = { read: async () => null, save: async () => undefined, flush: async () => undefined };
  const service = new RuntimeBrowserService({} as RuntimeBrowserPool, persistence as unknown as RuntimeBrowserPersistence);
  try {
    await service.connect(1, 'viewer', 'identity');
    expect(() => service.viewer(1, '界'.repeat(36))).toThrow(ForbiddenException);
  } finally { await service.onModuleDestroy(); }
});

it('invalidates state when discovered task servers change without granting access', async () => {
  const task = new RuntimeBrowserTask(1, {} as RuntimeBrowserPool, 'identity');
  const initial = task.state();
  task.setPorts([4310]);
  expect(task.state().revision).toBeGreaterThan(initial.revision);
  expect(task.state().ports).toEqual([4310]);
  const revision = task.state().revision;
  task.setPorts([4310]);
  expect(task.state().revision).toBe(revision);
  task.setPorts([]);
  expect(task.state().revision).toBeGreaterThan(revision);
  expect(task.state().ports).toEqual([]);
  await task.destroy();
});

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

it('retains task execution and agent ownership after viewer disconnect and lease expiry', async () => {
  jest.useFakeTimers();
  const persistence = { read: async () => null, save: async () => true, flush: async () => undefined };
  const service = new RuntimeBrowserService({} as RuntimeBrowserPool, persistence as unknown as RuntimeBrowserPersistence);
  try {
    const { token } = await service.connect(1, 'viewer', 'identity');
    const task = service.viewer(1, token);
    const tab = await task.create('agent', 2, '');
    const generation = tab.generation;
    service.disconnect(1, token);
    jest.advanceTimersByTime(3600000);
    expect(service.active(1)).toBe(task);
    const state = await task.agent({ kind: 'list' }, 2, new AbortController().signal);
    expect(state.tabs[0]).toMatchObject({ driver: 'agent', generation });
    const reconnect = await service.connect(1, 'viewer', 'identity');
    expect(reconnect.state.tabs[0]).toMatchObject({ driver: 'agent', generation });
    expect(() => service.viewer(1, token)).toThrow();
  } finally { await service.onModuleDestroy(); jest.useRealTimers(); }
});

it('tolerates a jitter pause without releasing the viewer and still expires an abandoned lease', async () => {
  jest.useFakeTimers();
  const persistence = { read: async () => null, save: async () => true, flush: async () => undefined };
  const service = new RuntimeBrowserService({} as RuntimeBrowserPool, persistence as unknown as RuntimeBrowserPersistence);
  try {
    const { token } = await service.connect(1, 'viewer', 'identity');
    jest.advanceTimersByTime(14000);
    expect(service.viewer(1, token)).toBe(service.active(1));
    jest.advanceTimersByTime(31000);
    expect(() => service.viewer(1, token)).toThrow('expired');
  } finally { await service.onModuleDestroy(); jest.useRealTimers(); }
});

it('refuses capacity pressure instead of silently destroying retained browser tabs', async () => {
  const persistence = { read: async () => null, save: async () => true, flush: async () => undefined };
  const service = new RuntimeBrowserService({} as RuntimeBrowserPool, persistence as unknown as RuntimeBrowserPersistence);
  try {
    for (let id = 1; id <= 4; id++) {
      const task = await service.prepare(id, 'identity-' + id);
      await task.create('agent', 2, '');
    }
    await expect(service.prepare(5, 'identity-5')).rejects.toThrow('limit');
    expect(service.active(1)?.tabs.size).toBe(1);
  } finally { await service.onModuleDestroy(); }
});

it('releases unviewed blank user tabs before refusing a fifth task', async () => {
  const persistence = { read: async () => null, save: async () => true, flush: async () => undefined };
  const service = new RuntimeBrowserService({} as RuntimeBrowserPool, persistence as unknown as RuntimeBrowserPersistence);
  try {
    for (let id = 1; id <= 4; id++) {
      const task = await service.prepare(id, 'identity-' + id);
      await task.create('you', null, '');
    }
    expect(await service.prepare(5, 'identity-5')).toBe(service.active(5));
    expect(service.active(1)).toBeNull();
  } finally { await service.onModuleDestroy(); }
});

it('stores tools on a blank tab and accepts its companion layout without launching an engine', async () => {
  const persistence = { read: async () => null, save: async () => true, flush: async () => undefined };
  const service = new RuntimeBrowserService({} as RuntimeBrowserPool, persistence as unknown as RuntimeBrowserPersistence);
  try {
    const task = await service.prepare(1, 'identity');
    const tab = await task.create('you', null, '');
    await task.command({ kind: 'theme', tabId: tab.id, theme: 'dark' });
    await task.command({ kind: 'network', tabId: tab.id, slow: true });
    await task.layoutTab(tab.id, 800, 600, true, true, 1, 'dark');
    expect(tab.started).toBe(false);
    expect(task.state().tabs[0]).toMatchObject({ theme: 'dark', slowNetwork: true, error: null });
  } finally { await service.onModuleDestroy(); }
});

it('closes retained browser resources when the durable task is archived', async () => {
  jest.useFakeTimers();
  let archived = false;
  const records = { record: async () => ({ taskState: 'ready', archivedAt: archived ? 'now' : null }) };
  const persistence = { read: async () => null, save: async () => true, flush: async () => undefined };
  const service = new RuntimeBrowserService({} as RuntimeBrowserPool, persistence as unknown as RuntimeBrowserPersistence, records as unknown as import('../tasks/tasks.service.js').TasksService);
  try {
    const task = await service.prepare(1, 'identity');
    await task.create('agent', 2, '');
    archived = true;
    await jest.advanceTimersByTimeAsync(1000);
    expect(service.active(1)).toBeNull();
    expect(task.alive).toBe(false);
  } finally { await service.onModuleDestroy(); jest.useRealTimers(); }
});
