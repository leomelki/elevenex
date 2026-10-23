import { AgentStandbyService } from './agent-standby.service.js';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: jest.fn(),
  getSubagentMessages: jest.fn(),
  listSubagents: jest.fn(),
  getSessionMessages: jest.fn(),
  query: jest.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AgentStandbyService lifecycle', () => {
  function setup() {
    let nextId = 1;
    const repo = {
      ensureAgentRepo: jest
        .fn()
        .mockResolvedValue({ repoId: 1, worktreePath: '/repo' }),
    };
    const sessions = {
      create: jest.fn(async () => ({ id: nextId++ })),
      archiveAndStop: jest.fn().mockResolvedValue(undefined),
      updateAgentAutonomyMode: jest.fn().mockResolvedValue(undefined),
      findBySurface: jest.fn().mockResolvedValue([]),
    };
    const tokens = { ensureToken: jest.fn().mockResolvedValue('token') };
    const runtime = {
      setAgentAutonomy: jest.fn().mockResolvedValue(undefined),
      prewarmSession: jest.fn().mockResolvedValue(undefined),
      isSessionWarm: jest.fn().mockReturnValue(true),
    };
    const service = new AgentStandbyService(
      repo as any,
      sessions as any,
      tokens as any,
      runtime as any,
      {
        findOne: jest
          .fn()
          .mockResolvedValue({ defaultAgentProvider: 'claude' }),
      } as any,
    );
    const warm = async (mode: 'review' | 'full' = 'review') => {
      service.scheduleStandby(mode);
      await (service as any).inFlight;
    };
    return { service, repo, sessions, tokens, runtime, warm };
  }

  it('coalesces matching warmups and transfers a claimed session without archiving it', async () => {
    const test = setup();
    test.service.scheduleStandby('review');
    test.service.scheduleStandby('review');
    await (test.service as any).inFlight;
    expect(test.sessions.create).toHaveBeenCalledTimes(1);
    expect(test.service.claimStandby('review')).toBe(1);
    await test.warm('full');
    expect(test.service.claimStandby('full')).toBe(2);
    await test.service.onModuleDestroy();
    expect(test.sessions.archiveAndStop).not.toHaveBeenCalled();
  });

  it.each([
    'mode mismatch',
    'expiry',
    'replacement',
    'provider change',
    'shutdown',
  ])('archives a ready standby on %s', async (reason) => {
    const test = setup();
    await test.warm();
    switch (reason) {
      case 'mode mismatch':
        expect(test.service.claimStandby('full')).toBeNull();
        break;
      case 'expiry':
        test.runtime.isSessionWarm.mockReturnValue(false);
        expect(test.service.claimStandby('review')).toBeNull();
        break;
      case 'replacement':
        await test.warm('full');
        break;
      case 'provider change':
        test.service.scheduleStandby('review', 'pi');
        break;
      case 'shutdown':
        await test.service.onModuleDestroy();
        break;
    }
    expect(
      test.sessions.archiveAndStop.mock.calls.filter(([id]) => id === 1),
    ).toEqual([[1]]);
    await test.service.onModuleDestroy();
  });

  it.each([
    'token',
    'autonomy persistence',
    'autonomy runtime',
    'prewarm',
    'not warm',
  ])('archives a failed standby at %s', async (stage) => {
    const test = setup();
    const failure = new Error('Warmup failed');
    switch (stage) {
      case 'token':
        test.tokens.ensureToken.mockRejectedValue(failure);
        break;
      case 'autonomy persistence':
        test.sessions.updateAgentAutonomyMode.mockRejectedValue(failure);
        break;
      case 'autonomy runtime':
        test.runtime.setAgentAutonomy.mockRejectedValue(failure);
        break;
      case 'prewarm':
        test.runtime.prewarmSession.mockRejectedValue(failure);
        break;
      case 'not warm':
        test.runtime.isSessionWarm.mockReturnValue(false);
        break;
    }
    await test.warm();
    expect(test.service.claimStandby('review')).toBeNull();
    expect(test.sessions.archiveAndStop).toHaveBeenCalledWith(1);
    await test.service.onModuleDestroy();
  });

  it.each(['provider change', 'replacement', 'shutdown'])(
    'does not publish a stale prewarm after %s',
    async (reason) => {
      const test = setup();
      const pending = deferred<void>();
      const entered = deferred<void>();
      test.runtime.prewarmSession.mockImplementationOnce(() => {
        entered.resolve();
        return pending.promise;
      });
      test.service.scheduleStandby('review');
      await entered.promise;
      const old = (test.service as any).inFlight;
      let shutdown: Promise<void> | undefined;
      if (reason === 'shutdown') shutdown = test.service.onModuleDestroy();
      else if (reason === 'replacement') test.service.scheduleStandby('full');
      else test.service.claimStandby('review', 'opencode');
      pending.resolve();
      await old;
      await (test.service as any).inFlight;
      await shutdown;
      expect(test.sessions.archiveAndStop).toHaveBeenCalledWith(1);
      if (reason === 'replacement')
        expect(test.service.claimStandby('full')).toBe(2);
      else expect(test.service.claimStandby('review')).toBeNull();
      await test.service.onModuleDestroy();
    },
  );

  it.each(['repo', 'create', 'token'])(
    'cancels stale warmups paused at %s and cleans up allocated sessions',
    async (stage) => {
      const test = setup();
      const pending = deferred<any>();
      const entered = deferred<void>();
      const pause = () => {
        entered.resolve();
        return pending.promise;
      };
      if (stage === 'repo')
        test.repo.ensureAgentRepo.mockImplementationOnce(pause);
      else if (stage === 'create')
        test.sessions.create.mockImplementationOnce(pause);
      else test.tokens.ensureToken.mockImplementationOnce(pause);
      test.service.scheduleStandby('review');
      await entered.promise;
      test.service.scheduleStandby('review', 'pi');
      pending.resolve(
        stage === 'repo'
          ? { repoId: 1, worktreePath: '/repo' }
          : stage === 'create'
            ? { id: 1 }
            : 'token',
      );
      await (test.service as any).inFlight;
      expect(test.runtime.prewarmSession).not.toHaveBeenCalled();
      if (stage === 'repo') expect(test.sessions.create).not.toHaveBeenCalled();
      else expect(test.sessions.archiveAndStop).toHaveBeenCalledWith(1);
      expect(test.service.claimStandby('review')).toBeNull();
      await test.service.onModuleDestroy();
    },
  );

  it('waits for standby archival during shutdown', async () => {
    const test = setup();
    await test.warm();
    const pending = deferred<void>();
    test.sessions.archiveAndStop.mockReturnValueOnce(pending.promise);
    let stopped = false;
    const shutdown = test.service.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    pending.resolve();
    await shutdown;
    expect(stopped).toBe(true);
  });
});
