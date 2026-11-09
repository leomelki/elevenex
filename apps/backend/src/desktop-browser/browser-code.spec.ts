import {
  BrowserAgentEngine,
  browserCodeCommand,
  browserCodeResult,
  type BrowserAgentHost,
  type BrowserAgentTarget,
} from '@elevenex/browser-agent';
import type { BrowserCodeCommand } from '@elevenex/shared';

describe('Code-first browser execution', () => {
  let engine: BrowserAgentEngine;
  let allowed: boolean;
  const send = jest.fn<Promise<unknown>, [string, Record<string, unknown>]>();
  const interrupt = jest.fn();
  const target = (): BrowserAgentTarget => ({
    id: 'tab',
    assert: () => {
      if (!allowed) throw new Error('Human takeover');
    },
    send,
    subscribe: () => () => undefined,
    goto: () => Promise.resolve(),
    close: () => Promise.resolve(),
    interrupt,
  });
  const host: BrowserAgentHost = {
    list: () => [{ id: 'tab', owned: true }],
    open: () => Promise.resolve(target()),
    get: () => Promise.resolve(target()),
  };
  const run = (
    code: string,
    session = 1,
    timeoutMs = 2000,
    signal = new AbortController().signal,
  ) => engine.execute(session, { kind: 'code', code, timeoutMs }, signal);
  beforeEach(() => {
    allowed = true;
    send.mockReset();
    interrupt.mockReset();
    send.mockImplementation((method) =>
      Promise.resolve(
        method === 'Runtime.evaluate' ? { result: { value: 7 } } : {},
      ),
    );
    engine = new BrowserAgentEngine(host);
  });
  afterEach(() => engine.dispose());

  it.each(['0', 'false', 'null', 'undefined', "''"])(
    'reports a falsy thrown value (%s) as an error',
    async (value) => {
      const result = await run(`throw ${value}`);
      expect(result.error?.message).toBeTruthy();
      expect(result.error?.outcomeUnknown).toBe(false);
    },
  );

  it('coalesces concurrent tab acquisition and orders commands on the real tab', async () => {
    const completed: string[] = [];
    send.mockImplementation(async (method, params) => {
      if (method === 'Input.insertText' && typeof params['text'] === 'string') {
        if (params['text'] === 'first')
          await new Promise((resolve) => setTimeout(resolve, 20));
        completed.push(params['text']);
      }
      return {};
    });
    const result = await run(`
      const [a,b] = await Promise.all([browser.tabs.get('tab'),browser.tabs.get('tab')]);
      await Promise.all([a.type('first'),b.type('second')]);
    `);
    expect(result.error).toBeUndefined();
    expect(
      send.mock.calls.filter(([method]) => method === 'Runtime.enable'),
    ).toHaveLength(1);
    expect(completed).toEqual(['first', 'second']);
  });

  it('batches operations, persists explicit state and isolates conversations', async () => {
    const first = await run(
      'state.tab = await browser.tabs.get("tab"); state.n = 1; console.log(await browser.tabs.list()); return await state.tab.evaluate(() => 7);',
    );
    expect(first).toMatchObject({
      value: 7,
      images: [],
      logs: [expect.stringContaining('tab') as unknown],
    });
    expect(await run('return ++state.n')).toMatchObject({
      value: 2,
      sandboxId: first.sandboxId,
    });
    expect(await run('return state.n ?? null', 2)).toMatchObject({
      value: null,
    });
    expect(await run('throw new Error("fix this")')).toMatchObject({
      error: { message: 'fix this', outcomeUnknown: false },
    });
    expect(await run('return state.n')).toMatchObject({
      value: 2,
      sandboxId: first.sandboxId,
    });
  });
  it('passes no host references into code, even through RPC results and errors', async () => {
    expect(
      (
        await run(
          'await browser.tabs.list(); return [typeof process,typeof require,typeof fetch,typeof Buffer];',
        )
      ).value,
    ).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
    for (const code of [
      'return console.log.constructor("return process")()',
      'return browser.tabs.list.constructor("return process")()',
      'return (await browser.tabs.list()).constructor.constructor("return process")()',
      'try { await browser.tabs.get("tab"); await state.missing(); } catch(e) { return e.constructor.constructor("return process")(); }',
      'return await import("node:fs")',
    ])
      expect((await run(code)).error).toBeDefined();
  });
  it('stops CPU and microtask loops and recovers without closing tabs or replaying code', async () => {
    for (const code of [
      'while(true) {}',
      'while(true) { await Promise.resolve(); }',
      'await new Promise(() => {})',
    ]) {
      const result = await run(code, 1, 300);
      expect(result.error?.outcomeUnknown).toBe(true);
      const recovered = await run('return await browser.tabs.list()');
      expect(recovered.value).toEqual([{ id: 'tab', owned: true }]);
      expect(recovered.sandboxId).not.toBe(result.sandboxId);
    }
  });
  it('does not inspect VM-thrown getters in the host realm', async () => {
    const result = await run(
      `return {toJSON() {throw {get message() {throw new Error('host getter executed')}}}}`,
    );
    expect(result.error?.message).toContain('non-serializable');
    expect((await run('return 42')).value).toBe(42);
  });
  it('cancels outstanding RPC, rejects queued writes and ignores late replies', async () => {
    await run('state.tab = await browser.tabs.get("tab")');
    let release!: (value: unknown) => void, started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    send.mockImplementation(async (method) => {
      if (method !== 'Runtime.evaluate') return {};
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const controller = new AbortController();
    const pending = run(
      'await state.tab.evaluate(() => 7); await state.tab.type("must not run")',
      1,
      2000,
      controller.signal,
    );
    await entered;
    controller.abort();
    expect((await pending).error?.outcomeUnknown).toBe(true);
    release({ result: { value: 7 } });
    expect(interrupt).toHaveBeenCalled();
    expect(
      send.mock.calls.some(([method]) => method === 'Input.insertText'),
    ).toBe(false);
  });
  it('rejects overlapping scripts, and revoked tab reads as well as writes', async () => {
    const first = run('await browser.wait(100); return 1');
    expect(engine.active).toBe(true);
    await expect(run('return 2')).rejects.toThrow('already running');
    await first;
    expect(engine.active).toBe(false);
    await run('state.tab = await browser.tabs.get("tab")');
    allowed = false;
    expect(
      (await run('return await state.tab.evaluate(() => 7)')).error?.message,
    ).toContain('takeover');
    expect((await run('await state.tab.type("no")')).error).toBeDefined();
  });
  it('bounds output and denies browser-wide, file and debugging transport commands', async () => {
    await run('state.tab = await browser.tabs.get("tab")');
    for (const method of [
      'Browser.close',
      'Target.attachToTarget',
      'DOM.setFileInputFiles',
      'Network.loadNetworkResource',
      'Page.navigate',
      'Page.captureScreenshot',
    ]) {
      expect(
        (await run(`return await state.tab.cdp(${JSON.stringify(method)})`))
          .error?.message,
      ).toContain('unavailable');
      expect(send.mock.calls.some(([name]) => name === method)).toBe(false);
    }
    expect((await run('return "x".repeat(1048577)')).error).toBeDefined();
    expect((await run('return "😀".repeat(300000)')).error).toBeDefined();
    expect((await run('console.log("x".repeat(32001))')).error).toBeDefined();
  });
  it('validates private transport images, errors and request budgets', () => {
    const command: BrowserCodeCommand = {
      kind: 'code',
      code: 'return 1',
      timeoutMs: 15000,
    };
    expect(browserCodeCommand(command)).toEqual(command);
    expect(() =>
      browserCodeCommand({ ...command, timeoutMs: 100000 }),
    ).toThrow();
    expect(() => browserCodeCommand({ ...command, shell: 'bad' })).toThrow();
    const reply = { sandboxId: 'id', value: 1, logs: [], images: [] };
    expect(browserCodeResult(reply)).toEqual(reply);
    expect(() => browserCodeResult({ ...reply, extra: 'secret' })).toThrow();
    expect(() =>
      browserCodeResult({
        ...reply,
        images: [{ data: 'bad!', mimeType: 'image/jpeg', width: 1, height: 1 }],
      }),
    ).toThrow();
  });
});
