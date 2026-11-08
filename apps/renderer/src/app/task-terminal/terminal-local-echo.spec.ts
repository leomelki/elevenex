import { TerminalSurface } from './terminal-surface';

vi.hoisted(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
afterAll(() => vi.unstubAllGlobals());

const drain = (surface: TerminalSurface) => new Promise<void>(resolve => surface.terminal.write('', resolve));
async function setup(prompt: number | undefined = 100) {
  const input = vi.fn(() => true);
  const surface = new TerminalSurface(input, () => {}, () => { throw new Error('No DOM'); });
  vi.spyOn(surface, 'fit').mockImplementation(() => {});
  surface.localEcho.latencyThreshold = 0;
  surface.setEnabled(true); await surface.write('$ '); surface.localEcho.reconcile(prompt);
  return { surface, input };
}

describe('Reversible terminal prediction', () => {
  afterEach(() => vi.restoreAllMocks());
  it('renders in xterm, exposes visible text to selection/search and reconciles partial echoes without duplication', async () => {
    const { surface } = await setup();
    try {
      surface.terminal.input('hello', true); await drain(surface);
      expect(surface.context()).toBe('$ hello');
      const select = vi.spyOn(surface.terminal, 'select').mockImplementation(() => {});
      expect(surface.search('hello').matches).toBe(1);
      expect(select).toHaveBeenCalledWith(2, 0, 5);
      await surface.write('he'); surface.localEcho.reconcile(100); await drain(surface);
      expect(surface.context()).toBe('$ hello');
      await surface.write('llo'); surface.localEcho.reconcile(100); await drain(surface);
      expect(surface.context()).toBe('$ hello'); expect(surface.localEcho.predicting).toBe(false);
    } finally { surface.dispose(); }
  });
  it('does not treat an empty output/input acknowledgement as confirmation', async () => {
    const { surface } = await setup();
    try {
      surface.terminal.input('pending', true); await drain(surface);
      await surface.write(''); surface.localEcho.reconcile(100, surface.localEcho.inputRevision, true, false); await drain(surface);
      expect(surface.localEcho.predicting).toBe(true);
      surface.localEcho.suspend(); await drain(surface);
      expect(surface.context()).toBe('$');
    } finally { surface.dispose(); }
  });
  it('predicts cursor editing and insertion, and restores a mismatched line exactly', async () => {
    const { surface } = await setup();
    try {
      surface.terminal.input('abc', true);
      surface.terminal.input('\x1b[D', true); surface.terminal.input('Z', true); await drain(surface);
      expect(surface.context()).toBe('$ abZc');
      await surface.write('abc\x1b[D\x1b[@Z'); surface.localEcho.reconcile(100); await drain(surface);
      expect(surface.context()).toBe('$ abZc'); expect(surface.localEcho.predicting).toBe(false);
      surface.terminal.input('\x7f', true); await drain(surface);
      expect(surface.context()).toBe('$ abc');
      await surface.write('\r\x1b[2K$ different'); surface.localEcho.reconcile(100); await drain(surface);
      expect(surface.context()).toBe('$ different');
      surface.terminal.input('x', true); await drain(surface);
      expect(surface.context()).toBe('$ different');
    } finally { surface.dispose(); }
  });
  it('rolls back styled characters and the current drawing attributes', async () => {
    const { surface } = await setup(undefined);
    try {
      surface.reset(); surface.setEnabled(true);
      await surface.write('\x1b[32m$ \x1b[0m'); surface.localEcho.reconcile(200);
      surface.terminal.input('abc', true); await drain(surface);
      surface.localEcho.suspend(); await drain(surface);
      await surface.write('real');
      const line = surface.terminal.buffer.active.getLine(0)!;
      expect(line.translateToString(true)).toBe('$ real');
      expect(line.getCell(0)!.getFgColor()).toBe(2);
      expect(line.getCell(2)!.isFgDefault()).toBe(true);
    } finally { surface.dispose(); }
  });
  it.each(['\r', '\n', '\x03', '\x1b[A', '\t', '\x1b[200~paste\x1b[201~', '🙂', 'x'.repeat(257)])(
    'revokes prediction across unsupported/secret-input boundaries %j', async data => {
      const { surface } = await setup();
      try {
        surface.terminal.input('x', true); await drain(surface);
        surface.terminal.input(data, true); await drain(surface);
        surface.localEcho.reconcile(100);
        surface.terminal.input('secret', true); await drain(surface);
        expect(surface.context()).toBe('$');
      } finally { surface.dispose(); }
    },
  );
  it('requires a fresh, causally valid prompt and never predicts in alternate screens', async () => {
    const { surface } = await setup(undefined);
    try {
      const revision = surface.localEcho.inputRevision;
      surface.terminal.input('sudo command\r', true);
      surface.localEcho.reconcile(100, revision);
      surface.terminal.input('secret', true); await drain(surface);
      expect(surface.context()).toBe('$');
      surface.localEcho.reconcile(200, surface.localEcho.inputRevision, false);
      surface.terminal.input('secret', true); await drain(surface); expect(surface.context()).toBe('$');
      await surface.write('\x1b[?1049h'); surface.localEcho.reconcile(300);
      surface.terminal.input('secret', true); await drain(surface); expect(surface.context()).toBe('');
    } finally { surface.dispose(); }
  });
  it('measures echo latency without rendering predictions on a fast connection', async () => {
    const { surface } = await setup();
    try {
      surface.localEcho.latencyThreshold = 10000;
      for (const char of 'abcdef') {
        surface.terminal.input(char, true); await drain(surface);
        expect(surface.localEcho.predicting).toBe(false);
        await surface.write(char); surface.localEcho.reconcile(100);
      }
      expect(surface.context()).toBe('$ abcdef');
    } finally { surface.dispose(); }
  });
  it('automatically predicts after slow confirmed echoes, but requires new confidence at a fresh prompt', async () => {
    const { surface } = await setup();
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    surface.localEcho.latencyThreshold = 30;
    try {
      for (const char of 'abcd') {
        surface.terminal.input(char, true); await drain(surface);
        expect(surface.localEcho.predicting).toBe(false);
        clock += 75; await surface.write(char); surface.localEcho.reconcile(100);
      }
      surface.terminal.input('e', true); await drain(surface);
      expect(surface.context()).toBe('$ abcde'); expect(surface.localEcho.predicting).toBe(true);
      await surface.write('\r\n$ '); surface.localEcho.reconcile(200);
      surface.terminal.input('secret', true); await drain(surface);
      expect(surface.context()).not.toContain('secret'); expect(surface.localEcho.predicting).toBe(false);
    } finally { surface.dispose(); }
  });
  it('suppresses view protocol replies and queries never see a speculative cursor', async () => {
    const { surface, input } = await setup();
    try {
      surface.setServerProtocol(true);
      surface.terminal.input('abc', true); await drain(surface); input.mockClear();
      await surface.write('\x1b[6n\x1b[c\x1bP$qm\x1b\\');
      expect(input).not.toHaveBeenCalled(); expect(surface.context()).toBe('$');
      surface.setServerProtocol(false);
      await surface.write('\x1b[6n'); expect(input).toHaveBeenCalledWith('\x1b[1;3R');
    } finally { surface.dispose(); }
  });
  it('restores remote text when prediction is switched off', async () => {
    const { surface } = await setup();
    try {
      surface.terminal.input('tentative', true); await drain(surface);
      surface.localEcho.setEnabled(false); await drain(surface);
      expect(surface.context()).toBe('$');
      surface.localEcho.reconcile(200); surface.terminal.input('more', true); await drain(surface);
      expect(surface.context()).toBe('$');
    } finally { surface.dispose(); }
  });
  it('rolls back before grid reflow and queues reset behind speculative drawing', async () => {
    const { surface } = await setup();
    try {
      surface.terminal.input('tentative', true);
      await surface.write('', { cols: 10, rows: 8 });
      expect(surface.context()).toBe('$');
      await surface.write('\r\n$ '); surface.localEcho.reconcile(200);
      surface.terminal.input('old', true);
      surface.reset(); await surface.write('replacement');
      expect(surface.context().replaceAll('\n', '')).toBe('replacement');
    } finally { surface.dispose(); }
  });
  it('does not infer echo confidence from a net-zero edit or an empty acknowledgement', async () => {
    const { surface } = await setup();
    try {
      surface.terminal.input('x\x7f', true); await drain(surface);
      await surface.write(''); surface.localEcho.reconcile(100, surface.localEcho.inputRevision, true, false); await drain(surface);
      expect(surface.localEcho.predicting).toBe(true);
      surface.localEcho.suspend(); await drain(surface); expect(surface.context()).toBe('$');
    } finally { surface.dispose(); }
  });
});
