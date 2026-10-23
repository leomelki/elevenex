import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlannotatorSessionInfo,
  PlannotatorSessionWatcher,
  SessionMatchResult,
} from './session-watcher.service.js';

interface WatcherInternals {
  sessionsDir: string;
  poll(): Promise<void>;
  matchToElevenexSession(
    session: PlannotatorSessionInfo,
  ): Promise<SessionMatchResult>;
}

describe('PlannotatorSessionWatcher', () => {
  let service: PlannotatorSessionWatcher;
  let killSpy: jest.SpyInstance<boolean, Parameters<typeof process.kill>>;
  let directory: string;
  let internals: WatcherInternals;
  let matchSpy: jest.SpyInstance;

  const session = {
    pid: 12345,
    port: 19432,
    url: 'http://127.0.0.1:19432/',
    mode: 'plan' as const,
    project: '/tmp/project',
    startedAt: '2026-05-06T00:00:00.000Z',
    label: 'Plan Review',
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    service = new PlannotatorSessionWatcher();
    killSpy = jest.spyOn(process, 'kill').mockReturnValue(true);
    directory = await fs.mkdtemp(join(tmpdir(), 'plannotator-watcher-'));
    internals = service as unknown as WatcherInternals;
    internals.sessionsDir = directory;
    matchSpy = jest
      .spyOn(internals, 'matchToElevenexSession')
      .mockImplementation(async (data) => ({
        plannotatorSession: data,
        elevenexSessionId: 1,
        worktreePath: data.project,
      }));
  });

  afterEach(async () => {
    service.onModuleDestroy();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  function setKnownSessions(): void {
    (
      service as unknown as { knownSessions: Map<number, typeof session> }
    ).knownSessions.set(session.pid, session);
  }

  async function writeRegistration(
    contents = JSON.stringify(session),
  ): Promise<string> {
    const file = join(directory, 'session.json');
    await fs.writeFile(file, contents);
    return file;
  }

  it('preserves partial JSON and reads the completed registration on the next poll', async () => {
    const started = jest.fn();
    service.on('session-started', started);
    const file = await writeRegistration('{"pid":');
    await internals.poll();
    expect(await fs.readFile(file, 'utf8')).toBe('{"pid":');
    expect(started).not.toHaveBeenCalled();
    await writeRegistration();
    await internals.poll();
    expect(started).toHaveBeenCalledTimes(1);
    expect(service.getSessionByPid(session.pid)).toEqual(session);
  });

  it('keeps an established session through transient JSON and read failures', async () => {
    const ended = jest.fn();
    service.on('session-ended', ended);
    const file = await writeRegistration();
    await internals.poll();
    await writeRegistration('');
    await internals.poll();
    expect(service.getSessionByPid(session.pid)).toEqual(session);
    jest
      .spyOn(fs, 'readFile')
      .mockRejectedValueOnce(
        Object.assign(new Error('busy'), { code: 'EACCES' }),
      );
    await internals.poll();
    expect(await fs.readFile(file, 'utf8')).toBe('');
    expect(ended).not.toHaveBeenCalled();
    await writeRegistration();
    await internals.poll();
    expect(matchSpy).toHaveBeenCalledTimes(1);
    await fs.unlink(file);
    await internals.poll();
    expect(ended).toHaveBeenCalledWith({
      pid: session.pid,
      port: session.port,
    });
  });

  it('retries failed matching without deleting or prematurely publishing the registration', async () => {
    const file = await writeRegistration();
    matchSpy.mockRejectedValueOnce(new Error('temporary matching failure'));
    await internals.poll();
    expect(service.getActiveSessions()).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe(JSON.stringify(session));
    await internals.poll();
    expect(service.getSessionByPid(session.pid)).toEqual(session);
    expect(matchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    { ...session, pid: -1 },
    { ...session, pid: '12345' },
    { pid: session.pid },
  ])(
    'preserves invalid registrations without probing a process: %j',
    async (data) => {
      const contents = JSON.stringify(data);
      const file = await writeRegistration(contents);
      await internals.poll();
      expect(await fs.readFile(file, 'utf8')).toBe(contents);
      expect(killSpy).not.toHaveBeenCalled();
    },
  );

  it('deletes only a registration whose process is positively dead', async () => {
    const file = await writeRegistration();
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error('permission'), { code: 'EPERM' });
    });
    await internals.poll();
    expect(service.getSessionByPid(session.pid)).toEqual(session);
    expect(await fs.readFile(file, 'utf8')).toBe(JSON.stringify(session));
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    });
    await internals.poll();
    expect(await fs.readdir(directory)).toEqual([]);
    expect(service.getActiveSessions()).toEqual([]);
  });

  it('does not unlink a dead registration replaced while checking it', async () => {
    const replacement = { ...session, pid: session.pid + 1 };
    const file = await writeRegistration(JSON.stringify(replacement));
    jest.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(session));
    killSpy.mockImplementation((pid) => {
      if (pid === session.pid)
        throw Object.assign(new Error('dead'), { code: 'ESRCH' });
      return true;
    });
    await internals.poll();
    expect(await fs.readFile(file, 'utf8')).toBe(JSON.stringify(replacement));
    await internals.poll();
    expect(service.getSessionByPid(replacement.pid)).toEqual(replacement);
  });

  it('contains readdir errors from startup and interval polling and recovers', async () => {
    await writeRegistration();
    const readdirSpy = jest
      .spyOn(fs, 'readdir')
      .mockRejectedValue(
        Object.assign(new Error('unreadable'), { code: 'EACCES' }),
      );
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(readdirSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    readdirSpy.mockRestore();
    await internals.poll();
    expect(service.getSessionByPid(session.pid)).toEqual(session);
  });

  it('coalesces polls and suppresses matching results after destruction', async () => {
    await writeRegistration();
    let finishMatch!: (result: SessionMatchResult) => void;
    const matching = new Promise<SessionMatchResult>((resolve) => {
      finishMatch = resolve;
    });
    let matchStarted!: () => void;
    const reachedMatch = new Promise<void>((resolve) => {
      matchStarted = resolve;
    });
    matchSpy.mockImplementationOnce(() => {
      matchStarted();
      return matching;
    });
    const started = jest.fn();
    service.on('session-started', started);
    const polling = internals.poll();
    await reachedMatch;
    await internals.poll();
    expect(matchSpy).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    finishMatch({
      plannotatorSession: session,
      elevenexSessionId: 1,
      worktreePath: session.project,
    });
    await polling;
    expect(started).not.toHaveBeenCalled();
    expect(service.getActiveSessions()).toEqual([]);
  });

  it('does not remove a dead registration read after destruction', async () => {
    const file = await writeRegistration();
    let finishRead!: (contents: string) => void;
    let readStarted!: () => void;
    const reachedRead = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    jest.spyOn(fs, 'readFile').mockImplementationOnce(() => {
      readStarted();
      return new Promise((resolve) => {
        finishRead = resolve as (contents: string) => void;
      });
    });
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    });
    const polling = internals.poll();
    await reachedRead;
    service.onModuleDestroy();
    finishRead(JSON.stringify(session));
    await polling;
    expect(await fs.readFile(file, 'utf8')).toBe(JSON.stringify(session));
    expect(killSpy).not.toHaveBeenCalled();
  });

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
