import { EventEmitter } from 'node:events';
import { RuntimeBrowserDiagnostics } from './runtime-diagnostics.js';

function session() {
  const events = new EventEmitter();
  const protocol = {
    on: jest.fn().mockImplementation(events.on.bind(events)),
    off: jest.fn().mockImplementation(events.off.bind(events)),
    send: jest.fn().mockResolvedValue(undefined),
    detach: jest.fn().mockResolvedValue(undefined),
  };
  return { protocol, emit: events.emit.bind(events) };
}

function fixture() {
  const page = session();
  const runtime = session();
  const attach = jest.fn().mockResolvedValue(runtime.protocol);
  const countError = jest.fn();
  const ownerSince = 1000;
  jest.spyOn(Date, 'now').mockReturnValue(ownerSince);
  const origin = 'http://localhost:3000';
  const tab = new RuntimeBrowserDiagnostics(
    page.protocol,
    attach,
    (url) => url.origin === origin,
    countError,
  );
  const context = (id: number, frameId = 'main', contextOrigin = origin) =>
    runtime.emit('Runtime.executionContextCreated', {
      context: {
        id,
        origin: contextOrigin,
        auxData: { isDefault: true, frameId },
      },
    });
  const log = (id: number, value: string, timestamp = ownerSince + 1) =>
    runtime.emit('Runtime.consoleAPICalled', {
      executionContextId: id,
      type: 'log',
      args: [{ value }],
      timestamp,
    });
  const commit = (url = origin) => tab.committed({ id: 'main', url });
  return {
    tab,
    page,
    runtime,
    attach,
    countError,
    context,
    log,
    commit,
    ownerSince,
  };
}

afterEach(() => jest.restoreAllMocks());

it('pages browser logs and counts non-network errors without double-counting failed requests', async () => {
  const { tab, page, commit, countError, ownerSince } = fixture();
  await tab.start();
  tab.control(true);
  commit('https://public.example');
  const entry = { level: 'error', text: 'failed', timestamp: ownerSince + 1 };
  page.emit('Log.entryAdded', { entry: { ...entry, source: 'network' } });
  page.emit('Log.entryAdded', { entry: { ...entry, source: 'security' } });
  expect(countError).toHaveBeenCalledTimes(1);
  expect(page.protocol.send).toHaveBeenCalledWith('Log.enable');
  expect(await tab.read(0, 1)).toEqual({
    items: [
      {
        seq: 1,
        kind: 'browser',
        level: 'error',
        text: 'failed',
        source: 'network',
      },
    ],
    next: 1,
    hasMore: true,
    dropped: false,
  });
  expect((await tab.read(1, 10)).items).toEqual([
    expect.objectContaining({ source: 'security' }),
  ]);
  for (let i = 0; i < 128; i++) {
    page.emit('Log.entryAdded', {
      entry: {
        ...entry,
        level: 'info',
        source: 'other',
        text: 'x'.repeat(2048),
      },
    });
  }
  const pageAfterOverflow = await tab.read(0, 1);
  expect(pageAfterOverflow).toMatchObject({
    next: 3,
    hasMore: true,
    dropped: true,
  });
  expect(pageAfterOverflow.items[0].text).toHaveLength(1024);
  tab.dispose();
  expect(page.protocol.send).toHaveBeenCalledWith('Log.disable');
});

it('captures only the current task-server document and retires capture on public navigation', async () => {
  const f = fixture();
  f.tab.control(true);
  f.commit();
  await f.tab.read(0, 10);
  expect(f.runtime.protocol.send).toHaveBeenCalledWith('Runtime.enable');
  f.context(1, 'subframe');
  f.log(1, 'subframe');
  f.context(2, 'main', 'https://public.example');
  f.log(2, 'different origin');
  f.context(3);
  f.log(3, 'before acquisition', f.ownerSince - 1);
  f.log(3, 'task output');
  f.runtime.emit('Runtime.exceptionThrown', {
    timestamp: f.ownerSince + 2,
    exceptionDetails: { executionContextId: 3, text: 'Uncaught error' },
  });
  const local = await f.tab.read(0, 10);
  expect(local.items).toEqual([
    expect.objectContaining({ kind: 'console', text: 'task output' }),
    expect.objectContaining({ kind: 'pageerror', text: 'Uncaught error' }),
  ]);
  expect(f.countError).toHaveBeenCalledTimes(1);
  f.tab.navigationStarted();
  expect(f.runtime.protocol.detach).toHaveBeenCalledTimes(1);
  f.commit('https://public.example');
  f.log(3, 'late local output');
  expect((await f.tab.read(local.next, 10)).items).toEqual([]);
  expect(f.attach).toHaveBeenCalledTimes(1);
  f.tab.dispose();
});

it('detaches a pending console session on takeover before enabling it', async () => {
  const f = fixture();
  let attached!: (protocol: typeof f.runtime.protocol) => void;
  f.attach.mockReturnValueOnce(
    new Promise((resolve) => {
      attached = resolve;
    }),
  );
  f.tab.control(true);
  f.commit();
  f.tab.control(false);
  attached(f.runtime.protocol);
  await Promise.resolve();
  expect(f.runtime.protocol.detach).toHaveBeenCalledTimes(1);
  expect(f.runtime.protocol.send).not.toHaveBeenCalled();
  expect((await f.tab.read(0, 10)).items).toEqual([]);
  f.tab.dispose();
});

it('restores capture after a cancelled navigation and discards a stale frame lookup', async () => {
  const f = fixture();
  f.tab.control(true);
  f.commit();
  await f.tab.read(0, 10);
  f.tab.navigationStarted();
  await f.tab.navigationStopped(() =>
    Promise.resolve({ id: 'main', url: 'http://localhost:3000' }),
  );
  await f.tab.read(0, 10);
  expect(f.attach).toHaveBeenCalledTimes(2);

  f.tab.navigationStarted();
  let finish!: (frame: { id: string; url: string }) => void;
  const restore = f.tab.navigationStopped(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.commit('https://public.example');
  finish({ id: 'main', url: 'http://localhost:3000' });
  await restore;
  expect(f.attach).toHaveBeenCalledTimes(2);
  f.tab.dispose();
});
