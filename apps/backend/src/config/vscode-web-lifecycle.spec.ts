import { runInNewContext } from 'node:vm';
import { renderVSCodeWorkbenchHtml } from './vscode-web-launcher';

function launcher(domReady = true) {
  const listeners = new Map<string, (event: any) => void>();
  const bridgeListeners: Array<(event: any) => void> = [];
  const sent: any[] = [];
  const relayed: any[] = [];
  let observe!: () => void;
  const channel = {
    postMessage: (data: unknown) => relayed.push(data),
    close: jest.fn(),
    addEventListener: (_name: string, listener: (event: any) => void) =>
      bridgeListeners.push(listener),
  };
  const parent = { postMessage: (data: unknown) => sent.push(data) };
  const window = {
    parent,
    location: {
      origin: 'http://localhost',
      search: new URLSearchParams({
        generation: 'g1',
        workspace:
          'workspace-vfs://elevenex/?worktreePath=%2Frepo&generation=g1',
      }).toString(),
    },
    stop: jest.fn(),
    addEventListener: (name: string, listener: (event: any) => void) =>
      listeners.set(name, listener),
  };
  const observer = { observe: jest.fn(), disconnect: jest.fn() };
  const html = renderVSCodeWorkbenchHtml('<head></head>');
  const source = html.match(
    /<!-- elevenex:workbench-bootstrap -->\s*<script>([\s\S]*?)<\/script>/,
  )![1];
  runInNewContext(source, {
    window,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    document: {
      readyState: 'complete',
      body: {},
      querySelector: () => (domReady ? {} : null),
    },
    BroadcastChannel: function () {
      return channel;
    },
    MutationObserver: function (callback: () => void) {
      observe = callback;
      return observer;
    },
  });
  return {
    sent,
    relayed,
    observer,
    channel,
    window,
    parentMessage: (data: any) =>
      listeners.get('message')?.({ source: parent, data }),
    extension: (data: any) =>
      bridgeListeners.forEach((listener) => listener({ data })),
    event: (name: string, event = {}) => listeners.get(name)?.(event),
    workbench: () => {
      domReady = true;
      observe();
    },
  };
}

describe('VS Code workbench startup protocol', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const probe = {
    type: 'vscode-workbench-check-ready',
    generation: 'g1',
    requestId: 'attempt-1',
  };
  it('requires workbench, bridge, backend filesystem and socket readiness', () => {
    const runtime = launcher(false);
    runtime.parentMessage(probe);
    runtime.extension({ type: 'elevenex-file-bridge-ready' });
    expect(
      runtime.sent.some((message) => message.type === 'vscode-workbench-ready'),
    ).toBe(false);
    runtime.extension({
      type: 'elevenex-workspace-ready',
      requestId: probe.requestId,
    });
    expect(
      runtime.sent.some((message) => message.type === 'vscode-workbench-ready'),
    ).toBe(false);
    runtime.workbench();
    expect(runtime.sent.at(-1)).toMatchObject({
      type: 'vscode-workbench-ready',
      bridgeReady: true,
      workspaceReady: true,
      generation: 'g1',
      requestId: 'attempt-1',
    });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('times out missing extension readiness and cancels its HTTP/socket work', async () => {
    const runtime = launcher();
    runtime.parentMessage(probe);
    await jest.advanceTimersByTimeAsync(28000);
    expect(runtime.sent.at(-1)).toMatchObject({
      type: 'elevenex-editor-startup-error',
    });
    expect(runtime.relayed.at(-1)).toMatchObject({
      type: 'elevenex-editor-cancel',
    });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('does not cancel lazy extension activation on VS Code configuration probes', () => {
    const runtime = launcher();
    runtime.parentMessage(probe);
    runtime.event('unhandledrejection', {
      reason: new Error('ENOPRO: No file system provider found'),
    });
    expect(
      runtime.sent.some(
        (message) => message.type === 'elevenex-editor-startup-error',
      ),
    ).toBe(false);
    runtime.extension({ type: 'elevenex-file-bridge-ready' });
    runtime.extension({
      type: 'elevenex-workspace-ready',
      requestId: probe.requestId,
    });
    expect(runtime.sent.at(-1)).toMatchObject({
      type: 'vscode-workbench-ready',
    });
  });

  it('retains early runtime asset failures until the parent can observe them', () => {
    const runtime = launcher();
    runtime.event('error', { target: { tagName: 'SCRIPT' } });
    runtime.parentMessage(probe);
    expect(runtime.sent.at(-1)).toMatchObject({
      type: 'elevenex-editor-startup-error',
      message: expect.stringContaining('asset'),
    });
  });
  it('ignores stale workspace completion messages and bounds queued opens', () => {
    const runtime = launcher();
    runtime.parentMessage(probe);
    for (let i = 0; i < 5000; i++)
      runtime.parentMessage({ type: 'elevenex-open-file', path: `${i}.ts` });
    runtime.extension({ type: 'elevenex-workspace-ready', requestId: 'stale' });
    expect(
      runtime.relayed.filter(
        (message) => message.type === 'elevenex-open-file',
      ),
    ).toHaveLength(0);
    runtime.extension({ type: 'elevenex-file-bridge-ready' });
    runtime.extension({
      type: 'elevenex-workspace-ready',
      requestId: probe.requestId,
    });
    expect(
      runtime.relayed.filter(
        (message) => message.type === 'elevenex-open-file',
      ),
    ).toEqual([{ type: 'elevenex-open-file', path: '4999.ts' }]);
  });
  it('preserves document checks after cancellation and cleans up on unload', () => {
    const runtime = launcher(false);
    runtime.parentMessage(probe);
    runtime.parentMessage({ type: 'elevenex-editor-cancel', generation: 'g1' });
    expect(runtime.window.stop).toHaveBeenCalledTimes(1);
    runtime.extension({
      type: 'elevenex-editor-check-result',
      requestId: 'dirty-check',
      dirty: 2,
    });
    expect(runtime.sent.at(-1)).toMatchObject({
      type: 'elevenex-editor-check-result',
      dirty: 2,
    });
    runtime.event('pagehide');
    expect(runtime.channel.close).toHaveBeenCalledTimes(1);
    expect(runtime.observer.disconnect).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
