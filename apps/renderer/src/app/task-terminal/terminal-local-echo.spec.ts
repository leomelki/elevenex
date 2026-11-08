import { TerminalSurface } from './terminal-surface';

vi.hoisted(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
afterAll(() => vi.unstubAllGlobals());

describe('Terminal speculative input', () => {
  async function setup(prompt: number | null = 100) {
    const input = vi.fn(() => true);
    const surface = new TerminalSurface(input, () => {}, () => { throw new Error('No renderer'); });
    vi.spyOn(surface, 'fit').mockImplementation(() => {});
    const element = document.createElement('div'), screen = document.createElement('div');
    screen.className = 'xterm-screen'; element.append(screen);
    vi.spyOn(surface.terminal, 'element', 'get').mockReturnValue(element);
    vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 480));
    surface.setEnabled(true);
    await surface.write('$ ');
    surface.localEcho.reconcile(prompt ?? undefined);
    const echo = () => screen.querySelector('.ex-terminal-local-echo');
    return { surface, input, echo };
  }
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('renders typing before any server reply without modifying authoritative text', async () => {
    const { surface, input, echo } = await setup();
    try {
      surface.terminal.input('hello', true);
      expect(input).toHaveBeenCalledWith('hello');
      expect(echo()?.textContent).toBe('hello ');
      expect(echo()?.getAttribute('aria-hidden')).toBe('true');
      expect(surface.context()).toBe('$');
      expect(surface.search('hello').matches).toBe(0);
      await surface.write('he'); surface.localEcho.reconcile(100);
      expect(echo()?.textContent).toBe('hello ');
      await surface.write('llo'); surface.localEcho.reconcile(100);
      expect(echo()).toBeNull();
      expect(surface.context()).toBe('$ hello');
    } finally { surface.dispose(); }
  });

  it('predicts backspace across pending and confirmed characters, including spaces', async () => {
    const { surface, echo } = await setup();
    try {
      surface.terminal.input('abc ', true);
      await surface.write('abc '); surface.localEcho.reconcile(100);
      surface.terminal.input('\x7f\x7f', true);
      expect(echo()?.textContent).toBe('ab   ');
      await surface.write('\b \b\b \b'); surface.localEcho.reconcile(100);
      expect(echo()).toBeNull();
      expect(surface.context()).toBe('$ ab');
    } finally { surface.dispose(); }
  });

  it.each(['\r', '\n', '\x03', '\x1b[A', '\t', '\x1b[200~paste\x1b[201~', '🙂', 'x'.repeat(257)])(
    'revokes prediction for submission/control/paste/unsupported input %j', async key => {
      const { surface, echo } = await setup();
      try {
        surface.terminal.input('x', true); expect(echo()).not.toBeNull();
        surface.terminal.input(key, true); expect(echo()).toBeNull();
        // A delayed pre-submission reply must never display a password.
        surface.localEcho.reconcile(100);
        surface.terminal.input('secret', true); expect(echo()).toBeNull();
      } finally { surface.dispose(); }
    },
  );

  it('does not arm a new prompt from a read that raced with user input', async () => {
    const { surface, echo } = await setup(null);
    try {
      const revision = surface.localEcho.inputRevision;
      surface.terminal.input('sudo command\r', true);
      surface.localEcho.reconcile(100, revision);
      surface.terminal.input('secret', true);
      expect(echo()).toBeNull();
      surface.localEcho.reconcile(100); // Still the consumed old grant.
      surface.terminal.input('secret', true);
      expect(echo()).toBeNull();
    } finally { surface.dispose(); }
  });

  it('requires a read begun after pending input was acknowledged before granting a new prompt', async () => {
    const { surface, echo } = await setup(null);
    try {
      surface.terminal.input('sudo command\r', true);
      surface.localEcho.reconcile(100, surface.localEcho.inputRevision, false);
      surface.terminal.input('secret', true);
      expect(echo()).toBeNull();
      // After acknowledgement the server revokes the old grant. A subsequent
      // genuine shell prompt is eligible again, including the same output page.
      surface.localEcho.reconcile(undefined);
      surface.localEcho.reconcile(200, surface.localEcho.inputRevision, true);
      surface.terminal.input('safe', true);
      expect(echo()?.textContent).toBe('safe ');
    } finally { surface.dispose(); }
  });

  it('supports Unicode in the prompt while leaving input cell widths to the server', async () => {
    const { surface, echo } = await setup(null);
    try {
      surface.reset(); surface.setEnabled(true);
      await surface.write('🙂 ~/project $ '); surface.localEcho.reconcile(200);
      surface.terminal.input('ascii', true);
      expect(echo()?.textContent).toBe('ascii ');
      await surface.write('ascii'); surface.localEcho.reconcile(200);
      expect(echo()).toBeNull();
    } finally { surface.dispose(); }
  });

  it('falls back to actual output on a mismatch and rearms only for a new prompt', async () => {
    const { surface, echo } = await setup();
    try {
      surface.terminal.input('wrong', true);
      await surface.write('different'); surface.localEcho.reconcile(100);
      expect(echo()).toBeNull();
      surface.terminal.input('x', true); expect(echo()).toBeNull();
      await surface.write('\r\n$ '); surface.localEcho.reconcile(200);
      surface.terminal.input('new', true); expect(echo()?.textContent).toBe('new ');
    } finally { surface.dispose(); }
  });

  it('handles shell ANSI redraws and coalesced insert/delete echoes without duplication', async () => {
    const { surface, echo } = await setup();
    try {
      surface.terminal.input('abc\x7f', true);
      await surface.write('\r\x1b[2K\x1b[32m$ ab\x1b[0m'); surface.localEcho.reconcile(100);
      expect(echo()).toBeNull();
      expect(surface.context()).toBe('$ ab');
    } finally { surface.dispose(); }
  });

  it('never predicts without a capability or in alternate-screen programs', async () => {
    const { surface, echo } = await setup(null);
    try {
      surface.terminal.input('legacy', true); expect(echo()).toBeNull();
      await surface.write('\x1b[?1049h'); surface.localEcho.reconcile(100);
      surface.terminal.input('secret', true); expect(echo()).toBeNull();
    } finally { surface.dispose(); }
  });

  it('clears on disable/detach/reset, bounds predictions and times out without replay', async () => {
    const { surface, echo, input } = await setup();
    try {
      vi.useFakeTimers();
      surface.terminal.input('x', true);
      vi.advanceTimersByTime(5000);
      expect(echo()).toBeNull(); expect(input).toHaveBeenCalledTimes(1);
      surface.localEcho.reconcile(200); surface.terminal.input('x', true);
      surface.setEnabled(false); expect(echo()).toBeNull();
      surface.setEnabled(true); surface.localEcho.reconcile(300); surface.terminal.input('x', true);
      surface.detach(); expect(echo()).toBeNull();
      surface.reset(); surface.setEnabled(true); surface.localEcho.reconcile(1); surface.terminal.input('x', true);
      expect(echo()).not.toBeNull();
    } finally { surface.dispose(); }
  });

  it('does not predict refused input', async () => {
    const { surface, echo, input } = await setup();
    try {
      input.mockReturnValue(false);
      surface.terminal.input('rejected paste', true);
      expect(echo()).toBeNull();
    } finally { surface.dispose(); }
  });
});
