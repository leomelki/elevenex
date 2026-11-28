import { terminatePtyAndWait } from './pty-termination.js';

describe('terminatePtyAndWait', () => {
  const platform = process.platform;
  let exit: () => void;
  let pty: { kill: jest.Mock; onExit: jest.Mock };
  let dispose: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    dispose = jest.fn();
    pty = {
      kill: jest.fn(),
      onExit: jest.fn((callback) => {
        exit = callback;
        return { dispose };
      }),
    };
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    jest.useRealTimers();
  });

  it('keeps the environment reserved until process exit and clears escalation timers', async () => {
    let stopped = false;
    const pending = terminatePtyAndWait(pty as never).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(pty.kill).toHaveBeenCalledWith('SIGTERM');
    exit();
    await pending;
    jest.advanceTimersByTime(10000);
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('escalates a process that ignores TERM and refuses to release an unresponsive process', async () => {
    const pending = terminatePtyAndWait(pty as never);
    const rejected = expect(pending).rejects.toThrow(
      'environment is still reserved',
    );
    jest.advanceTimersByTime(1500);
    expect(pty.kill).toHaveBeenLastCalledWith('SIGKILL');
    jest.advanceTimersByTime(5500);
    await rejected;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('closes a Windows PTY without signals and waits for exit', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    pty.kill.mockImplementation((signal?: string) => {
      if (signal) throw new Error('Signals not supported on windows.');
    });
    let stopped = false;
    const pending = terminatePtyAndWait(pty as never, {
      signal: 'SIGHUP',
      graceMs: 5000,
    }).then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(5000);
    expect(stopped).toBe(false);
    expect(pty.kill.mock.calls).toEqual([[]]);
    exit();
    await pending;
    expect(stopped).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('surfaces shutdown errors', async () => {
    pty.kill.mockImplementation(() => {
      throw new Error('permission denied');
    });
    await expect(terminatePtyAndWait(pty as never)).rejects.toThrow(
      'permission denied',
    );
    expect(jest.getTimerCount()).toBe(0);
  });
  it('coalesces stops of the same PTY, including a synchronous exit during kill', async () => {
    pty.kill.mockImplementation(() => exit());
    const first = terminatePtyAndWait(pty as never);
    const second = terminatePtyAndWait(pty as never);
    expect(first).toBe(second);
    await first;
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('treats ESRCH as exited and permits retry after another signal error', async () => {
    pty.kill.mockImplementationOnce(() => {
      throw new Error('permission denied');
    });
    await expect(terminatePtyAndWait(pty as never)).rejects.toThrow(
      'permission denied',
    );
    pty.kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    await terminatePtyAndWait(pty as never);
    expect(jest.getTimerCount()).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
