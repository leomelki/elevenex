import { terminatePtyAndWait } from './pty-termination.js';

describe('terminatePtyAndWait', () => {
  let exit: () => void;
  let process: { kill: jest.Mock; onExit: jest.Mock };
  let dispose: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers();
    dispose = jest.fn();
    process = {
      kill: jest.fn(),
      onExit: jest.fn((callback) => {
        exit = callback;
        return { dispose };
      }),
    };
  });
  afterEach(() => jest.useRealTimers());

  it('keeps the environment reserved until process exit and clears escalation timers', async () => {
    let stopped = false;
    const pending = terminatePtyAndWait(process as never).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    exit();
    await pending;
    jest.advanceTimersByTime(10000);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('escalates a process that ignores TERM and refuses to release an unresponsive process', async () => {
    const pending = terminatePtyAndWait(process as never);
    const rejected = expect(pending).rejects.toThrow(
      'environment is still reserved',
    );
    jest.advanceTimersByTime(1500);
    expect(process.kill).toHaveBeenLastCalledWith('SIGKILL');
    jest.advanceTimersByTime(5500);
    await rejected;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('surfaces shutdown errors', async () => {
    process.kill.mockImplementation(() => {
      throw new Error('permission denied');
    });
    await expect(terminatePtyAndWait(process as never)).rejects.toThrow(
      'permission denied',
    );
    expect(jest.getTimerCount()).toBe(0);
  });
});
