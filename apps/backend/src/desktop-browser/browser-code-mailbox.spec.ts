import { DesktopBrowserService } from './desktop-browser.service.js';

describe('Code-first desktop mailbox', () => {
  let service: DesktopBrowserService;
  const command = {
    kind: 'code' as const,
    code: 'return 42',
    timeoutMs: 15000,
  };
  const result = { sandboxId: 'state', value: 42, logs: [], images: [] };
  beforeEach(() => {
    service = new DesktopBrowserService();
    service.poll(1, 'desktop', 'lease', undefined, 1);
  });
  afterEach(() => service.onModuleDestroy());
  it('wakes an idle long poll immediately and never redelivers code', async () => {
    const wait = service.wait('desktop', 'lease', new AbortController().signal);
    const pending = service.requestCode(
      1,
      2,
      command,
      new AbortController().signal,
    );
    await wait;
    const delivered = service.poll(1, 'desktop', 'lease', undefined, 1);
    expect(delivered.command?.input).toEqual(command);
    expect(
      service.poll(1, 'desktop', 'lease', undefined, 1).command,
    ).toBeNull();
    service.poll(
      1,
      'desktop',
      'lease',
      { id: delivered.command!.id, value: result },
      1,
    );
    expect(await pending).toEqual(result);
  });
  it('admits separate conversations concurrently, but rejects overlapping scripts in one', async () => {
    const controller = new AbortController();
    const first = service
      .requestCode(1, 2, command, controller.signal)
      .catch(() => undefined);
    const second = service
      .requestCode(1, 3, command, controller.signal)
      .catch(() => undefined);
    const a = service.poll(1, 'desktop', 'lease', undefined, 1).command!;
    const b = service.poll(1, 'desktop', 'lease', undefined, 1, [
      a.id,
    ]).command!;
    expect(a.sessionId).toBe(2);
    expect(b.sessionId).toBe(3);
    await expect(
      service.requestCode(1, 2, command, controller.signal),
    ).rejects.toThrow('already running');
    controller.abort();
    await Promise.all([first, second]);
  });
  it('resets only the requested conversation and reports cancelled IDs to the desktop', async () => {
    const controller = new AbortController();
    const first = service.requestCode(1, 2, command, controller.signal);
    const stopped = expect(first).rejects.toThrow('reset');
    const delivered = service.poll(
      1,
      'desktop',
      'lease',
      undefined,
      1,
    ).command!;
    const reset = service.requestCode(
      1,
      2,
      { ...command, code: '', reset: true },
      controller.signal,
    );
    await stopped;
    const next = service.poll(1, 'desktop', 'lease', undefined, 1, [
      delivered.id,
    ]);
    expect(next.running).not.toContain(delivered.id);
    expect(next.command?.input['reset']).toBe(true);
    service.poll(
      1,
      'desktop',
      'lease',
      { id: next.command!.id, value: result },
      1,
    );
    await reset;
  });
  it('cleans idle waiters and preserves the old desktop metadata boundary', async () => {
    const controller = new AbortController();
    const wait = service.wait('desktop', 'lease', controller.signal);
    controller.abort();
    await wait;
    service.poll(2, 'old', 'lease');
    await expect(
      service.requestCode(2, 2, command, new AbortController().signal),
    ).rejects.toThrow('needs an update');
    expect(service.poll(2, 'old', 'lease')).toEqual({ command: null });
  });
});
