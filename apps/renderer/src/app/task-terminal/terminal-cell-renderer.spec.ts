import { TerminalCellRenderer } from './terminal-cell-renderer';

const gpu = vi.hoisted(() => {
  // Other terminal specs import the renderer through TerminalSurface. Clear
  // that cached module before installing this file's GPU ownership mock.
  vi.resetModules();
  return {
    disposed: vi.fn(),
    unsubscribed: vi.fn(),
    lost: undefined as (() => void) | undefined,
  };
});
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    activate() {}
    dispose = gpu.disposed;
    onContextLoss(listener: () => void) {
      gpu.lost = listener;
      return { dispose: gpu.unsubscribed };
    }
  },
}));

function setup(fail = false) {
  let insideLease = false;
  const open = <T>(operation: () => T): T => {
    insideLease = true;
    try { return operation(); } finally { insideLease = false; }
  };
  const terminal = {
    element: document.createElement('div'),
    loadAddon: vi.fn(() => {
      expect(insideLease).toBe(true);
      if (fail) throw new Error('WebGL2 unavailable');
    }),
  };
  gpu.disposed.mockImplementation(() => expect(insideLease).toBe(true));
  return { renderer: new TerminalCellRenderer(terminal, { open, release() {} }), terminal };
}

describe('Terminal cell renderer lifetime', () => {
  beforeEach(() => { vi.clearAllMocks(); gpu.lost = undefined; });

  it('owns one addon per attachment and frees it before reattaching', () => {
    const { renderer, terminal } = setup();
    renderer.attach(); renderer.attach();
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
    renderer.detach(); renderer.detach();
    expect(gpu.disposed).toHaveBeenCalledTimes(1);
    expect(gpu.unsubscribed).toHaveBeenCalledTimes(1);
    renderer.attach();
    expect(terminal.loadAddon).toHaveBeenCalledTimes(2);
    renderer.detach();
  });

  it('returns to DOM rendering after context loss and retries on the next attachment', () => {
    const { renderer, terminal } = setup();
    renderer.attach(); gpu.lost?.();
    expect(gpu.disposed).toHaveBeenCalledTimes(1);
    expect(gpu.unsubscribed).toHaveBeenCalledTimes(1);
    renderer.attach();
    expect(terminal.loadAddon).toHaveBeenCalledTimes(2);
    renderer.detach();
  });

  it('cleans up a failed activation without preventing terminal use', () => {
    const { renderer } = setup(true);
    expect(() => renderer.attach()).not.toThrow();
    expect(gpu.disposed).toHaveBeenCalledTimes(1);
    expect(gpu.unsubscribed).toHaveBeenCalledTimes(1);
    renderer.detach();
    expect(gpu.disposed).toHaveBeenCalledTimes(1);
  });
});
