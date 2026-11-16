import { TerminalSurface } from './terminal-surface';

// xterm installs media listeners at import time. The test runner's partial
// matchMedia shim lacks these methods; establish them before static imports.
vi.hoisted(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
afterAll(() => vi.unstubAllGlobals());

// Real ANSI parsing and buffer reflow; only container measurement needs a browser.
describe('Terminal output geometry', () => {
  function setup() {
    const resized = vi.fn();
    const surface = new TerminalSurface(() => {}, resized, () => {
      throw new Error('These buffer tests must not mount a DOM renderer');
    });
    const fit = vi.spyOn(surface, 'fit').mockImplementation(() => {});
    return { surface, resized, fit };
  }

  it('keeps zsh startup at the first row when replaying an 80-column prompt into a narrow pane', async () => {
    const { surface, resized, fit } = setup();
    try {
      surface.terminal.resize(32, 8);
      resized.mockClear();
      // zsh PROMPT_SP clears a partial line with a full row of spaces, then CR.
      // Parsing this at 32 columns would leave two blank rows above READY>.
      const startup = '\x1b[7m%\x1b[0m' + ' '.repeat(79) + '\r \r\r\x1b[JREADY> ';
      await surface.write(startup, { cols: 80, rows: 24 }, true);
      expect(surface.terminal.buffer.active.cursorY).toBe(0);
      expect(surface.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('READY> ');
      expect(fit).not.toHaveBeenCalled();
      // The next page was produced after the PTY resized, including a redraw.
      await surface.write('\r\x1b[2KREADY> ', { cols: 32, rows: 8 });
      expect(surface.terminal.cols).toBe(32);
      expect(surface.terminal.buffer.active.cursorY).toBe(0);
      expect(resized).not.toHaveBeenCalled();
      expect(fit).toHaveBeenCalledTimes(1);
    } finally { surface.dispose(); }
  });

  it('applies resize-only pages and still accepts output from older engines', async () => {
    const { surface, resized, fit } = setup();
    try {
      await surface.write('', { cols: 40, rows: 10 });
      expect(surface.terminal.cols).toBe(40);
      expect(surface.terminal.rows).toBe(10);
      expect(resized).not.toHaveBeenCalled();
      expect(fit).toHaveBeenCalledTimes(1);
      await surface.write('legacy output');
      expect(surface.context()).toBe('legacy output');
    } finally { surface.dispose(); }
  });
});

describe('Command navigation', () => {
  it('uses trusted boundaries through replay and reset', async () => {
    const surface = new TerminalSurface(() => {}, () => {}, () => { throw new Error('No DOM'); });
    vi.spyOn(surface, 'fit').mockImplementation(() => {});
    try {
      const scroll = vi.spyOn(surface.terminal, 'scrollToLine');
      const first = 'first> command\r\n', second = 'result\r\nsecond> command\r\n';
      await surface.write(first + second + 'done\r\n', undefined, false,
        [{ id: 1, at: first.length }, { id: 2, at: first.length + second.length }], 0);
      expect(surface.navigateCommand(true)).toBe(true);
      expect(scroll).toHaveBeenLastCalledWith(3);
      surface.navigateCommand(true);
      expect(scroll).toHaveBeenLastCalledWith(1);
      surface.navigateCommand(false);
      expect(scroll).toHaveBeenLastCalledWith(3);
      surface.reset();
      expect(surface.navigateCommand(true)).toBe(false);
      await surface.write('\x1b]133;C;aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\x07');
      expect(surface.navigateCommand(true)).toBe(false);
    } finally { surface.dispose(); }
  });
});

describe('Terminal color query ownership', () => {
  beforeEach(() => vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null));
  afterEach(() => vi.restoreAllMocks());

  function setup() {
    const input = vi.fn();
    const surface = new TerminalSurface(input, () => {}, () => { throw new Error('No style adapter needed'); });
    vi.spyOn(surface, 'fit').mockImplementation(() => {});
    // Color replies require a mounted xterm theme service, unlike CPR/DA.
    const host = document.createElement('div');
    document.body.append(host);
    surface.terminal.open(host);
    surface.setEnabled(true);
    return { surface, input, dispose: () => { surface.dispose(); host.remove(); } };
  }

  it('leaves the OSC 11 / CPR probe to the server without sending a late color reply as keyboard input', async () => {
    const { surface, input, dispose } = setup();
    try {
      surface.setServerProtocol(true);
      // termenv (used by gh) stops waiting for color when the server's CPR
      // arrives. The view may receive this output after gh starts its prompt.
      await surface.write('\x1b]11;?\x1b\\\x1b[6n');
      expect(input).not.toHaveBeenCalled();
      surface.terminal.input('\x1b[B', true);
      surface.terminal.input('\r', true);
      expect(input.mock.calls).toEqual([['\x1b[B'], ['\r']]);
    } finally { dispose(); }
  });

  it('suppresses palette, foreground, background and cursor queries across chunks and terminators', async () => {
    const { surface, input, dispose } = setup();
    try {
      surface.setServerProtocol(true);
      for (const query of ['4;0;?;255;?', '10;?', '11;?', '12;?', '10;?;?;?']) {
        for (const end of ['\x07', '\x1b\\']) {
          const data = `\x1b]${query}${end}`;
          for (const char of data) await surface.write(char);
        }
      }
      expect(input).not.toHaveBeenCalled();
    } finally { dispose(); }
  });

  it('preserves color setters and legacy query replies when server ownership is disabled', async () => {
    const { surface, input, dispose } = setup();
    try {
      surface.setServerProtocol(true);
      await surface.write('\x1b]11;#123456\x07');
      surface.setServerProtocol(false);
      await surface.write('\x1b]11;?\x07\x1b[6n');
      expect(input.mock.calls).toEqual([['\x1b]11;rgb:1212/3434/5656\x1b\\'], ['\x1b[1;1R']]);
      input.mockClear();
      await surface.write('\x1b]4;0;?\x07\x1b]10;?\x07\x1b]12;?\x07');
      expect(input.mock.calls.map(([data]) => data)).toEqual([
        expect.stringContaining('\x1b]4;0;rgb:'),
        expect.stringContaining('\x1b]10;rgb:'),
        expect.stringContaining('\x1b]12;rgb:'),
      ]);
    } finally { dispose(); }
  });
});
