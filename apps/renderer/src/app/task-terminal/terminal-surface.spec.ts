import { TerminalSurface } from './terminal-surface';

// xterm installs media listeners at import time. The test runner's partial
// matchMedia shim lacks these methods; establish them before static imports.
vi.hoisted(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
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
