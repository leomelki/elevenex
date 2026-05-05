import { PlannotatorSessionWatcher } from './session-watcher.service.js';

describe('PlannotatorSessionWatcher', () => {
  let service: PlannotatorSessionWatcher;
  let killSpy: jest.SpyInstance<boolean, Parameters<typeof process.kill>>;

  const session = {
    pid: 12345,
    port: 19432,
    url: 'http://127.0.0.1:19432/',
    mode: 'plan' as const,
    project: '/tmp/project',
    startedAt: '2026-05-06T00:00:00.000Z',
    label: 'Plan Review',
  };

  beforeEach(() => {
    jest.useFakeTimers();
    service = new PlannotatorSessionWatcher();
    killSpy = jest.spyOn(process, 'kill').mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
    killSpy.mockRestore();
  });

  function setKnownSessions(): void {
    (service as unknown as { knownSessions: Map<number, typeof session> }).knownSessions.set(
      session.pid,
      session,
    );
  }

  it('terminates the process matching a known port', () => {
    setKnownSessions();

    expect(service.terminateSessionByPort(session.port)).toBe(true);

    expect(killSpy).toHaveBeenCalledWith(session.pid, 'SIGTERM');
  });

  it('returns false and does not kill when no session matches the port', () => {
    expect(service.terminateSessionByPort(1234)).toBe(false);

    expect(killSpy).not.toHaveBeenCalled();
  });

  it('schedules a SIGKILL fallback when the process remains alive', () => {
    setKnownSessions();
    killSpy.mockImplementation((pid, signal) => {
      if (pid !== session.pid) {
        throw new Error('unexpected pid');
      }
      if (signal === 0) {
        return true;
      }
      return true;
    });

    expect(service.terminateSessionByPort(session.port)).toBe(true);
    jest.advanceTimersByTime(5000);

    expect(killSpy).toHaveBeenCalledWith(session.pid, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(session.pid, 0);
    expect(killSpy).toHaveBeenCalledWith(session.pid, 'SIGKILL');
  });
});
