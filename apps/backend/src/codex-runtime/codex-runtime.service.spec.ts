import { jest } from '@jest/globals';
import { CodexRuntimeService } from './codex-runtime.service.js';

describe('CodexRuntimeService', () => {
  const session = {
    id: 7,
    repoId: 1,
    worktreePath: '/tmp/project',
    codexSessionId: '-1',
  };

  function createService() {
    const sessionsService = {
      findOne: jest.fn<() => Promise<typeof session>>().mockResolvedValue(session),
      updateStatus: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
      updateCodexSessionId: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
    };
    const authService = {
      getFastStatus: jest.fn<() => Promise<unknown>>().mockResolvedValue({
        installed: true,
        authenticated: true,
        authMethod: 'oauth',
        version: null,
      }),
      getStatus: jest.fn<() => Promise<unknown>>().mockResolvedValue({
        installed: true,
        authenticated: true,
        authMethod: 'oauth',
        version: 'codex 1.0.0',
      }),
    };
    const historyService = {
      getHistory: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    };
    const appServer = {
      prewarm: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      request: jest.fn<() => Promise<unknown>>().mockResolvedValue({ data: [] }),
      addRef: jest.fn(),
      release: jest.fn(),
      ensureReady: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      onNotification: jest.fn(() => () => undefined),
      onRequest: jest.fn(() => () => undefined),
      respondToRequest: jest.fn(),
      rejectRequest: jest.fn(),
    };

    return {
      service: new CodexRuntimeService(
        sessionsService as never,
        authService as never,
        historyService as never,
        appServer as never,
      ),
      sessionsService,
      authService,
      appServer,
    };
  }

  it('prewarms the shared app-server and caches session metadata', async () => {
    const { service, sessionsService, authService, appServer } = createService();

    await service.prewarmSession(7);

    expect(sessionsService.findOne).toHaveBeenCalledTimes(1);
    expect(authService.getFastStatus).toHaveBeenCalledTimes(1);
    expect(appServer.prewarm).toHaveBeenCalledTimes(1);
    expect((service as any).runtimeStates.get(7).cachedWorktreePath).toBe(
      '/tmp/project',
    );
  });

  it('coalesces concurrent prewarm calls for one session', async () => {
    const { service, sessionsService, appServer } = createService();
    let resolvePrewarm!: () => void;
    appServer.prewarm.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePrewarm = resolve;
      }),
    );

    const first = service.prewarmSession(7);
    const second = service.prewarmSession(7);
    await new Promise((resolve) => setImmediate(resolve));
    resolvePrewarm();
    await Promise.all([first, second]);

    expect(sessionsService.findOne).toHaveBeenCalledTimes(1);
    expect(appServer.prewarm).toHaveBeenCalledTimes(1);
  });

  it('uses fast auth status for the initial runtime state', async () => {
    const { service, authService } = createService();

    await service.getRuntimeState(7);

    expect(authService.getFastStatus).toHaveBeenCalledTimes(1);
    expect(authService.getStatus).not.toHaveBeenCalled();
  });

  it('lists models through the shared app-server client', async () => {
    const { service, appServer } = createService();
    appServer.request.mockResolvedValueOnce({
      data: [{ id: 'gpt-test', displayName: 'GPT Test' }],
    });

    const models = await (service as any).fetchCodexAppServerModels();

    expect(appServer.request).toHaveBeenCalledWith(
      'model/list',
      { limit: 100, includeHidden: false },
      8000,
    );
    expect(models).toEqual([{ id: 'gpt-test', displayName: 'GPT Test' }]);
  });
});
