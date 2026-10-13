/* Async mocks intentionally implement the native promise API without I/O. */
/* eslint-disable @typescript-eslint/require-await */
import { EventEmitter } from 'node:events';
import { OpenCodeServer } from './opencode-server.js';
import { OpenCodeCatalogService } from './opencode-catalog.service.js';

jest.mock('./opencode-server.js', () => ({ OpenCodeServer: jest.fn() }));

function fixture() {
  const client = {
    provider: {
      list: jest.fn(async () => ({
        data: {
          all: [
            {
              id: 'local',
              name: 'Local',
              models: {
                model: {
                  id: 'model',
                  name: 'Model',
                  status: 'active',
                  variants: {},
                },
              },
            },
          ],
          connected: ['local'],
        },
      })),
      auth: jest.fn(async () => ({
        data: { local: [{ type: 'api' }, { type: 'oauth', label: 'Browser' }] },
      })),
      oauth: {
        authorize: jest.fn(async () => ({
          data: {
            url: 'https://example.org/login',
            method: 'code',
            instructions: 'Enter code',
          },
        })),
        callback: jest.fn(async () => ({ data: true })),
      },
    },
    config: { get: jest.fn(async () => ({ data: { model: 'local/model' } })) },
    global: { health: jest.fn(async () => ({ data: { version: '2' } })) },
    auth: { set: jest.fn(async () => ({ data: true })) },
    instance: { dispose: jest.fn(async () => ({ data: true })) },
    cancelOAuth: jest.fn(async () => {}),
  };
  const server = Object.assign(new EventEmitter(), {
    start: jest.fn(async () => client),
    close: jest.fn(),
  });
  (OpenCodeServer as jest.Mock).mockImplementation(() => server);
  return { service: new OpenCodeCatalogService(), client, server };
}

describe('OpenCode catalogs and authentication', () => {
  afterEach(() => jest.clearAllMocks());
  it('queues one fresh probe after an older probe for concurrent reloads', async () => {
    const f = fixture();
    let finish!: () => void;
    f.server.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(f.client);
        }),
    );
    try {
      const automatic = f.service.refreshNow();
      const first = f.service.getModelCatalog(true);
      const second = f.service.getModelCatalog(true);
      expect(f.server.close).not.toHaveBeenCalled();
      finish();
      await Promise.all([automatic, first, second]);
      expect(f.server.close).toHaveBeenCalledTimes(1);
      expect(OpenCodeServer).toHaveBeenCalledTimes(2);
      expect(f.client.provider.list).toHaveBeenCalledTimes(2);
    } finally {
      f.service.onModuleDestroy();
    }
  });

  it('keeps the catalog server when login starts while a reload is queued', async () => {
    const f = fixture();
    let finish!: () => void;
    f.server.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(f.client);
        }),
    );
    try {
      const automatic = f.service.refreshNow();
      const forced = f.service.getModelCatalog(true);
      (f.service as any).login = { controller: new AbortController() };
      finish();
      await automatic;
      expect((await forced).unavailableReason).toContain('Finish signing in');
      expect(f.server.close).not.toHaveBeenCalled();
      expect(OpenCodeServer).toHaveBeenCalledTimes(1);
    } finally {
      f.service.onModuleDestroy();
    }
  });
  it('does not hold up automatic reads for a pending catalog probe', async () => {
    const f = fixture();
    const probe = jest
      .spyOn(f.service, 'refreshNow')
      .mockReturnValue(new Promise(() => {}));
    try {
      const catalog = await f.service.getModelCatalog();
      expect(catalog.models).toEqual([]);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(f.server.close).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
      f.service.onModuleDestroy();
    }
  });
  it('restarts only the catalog server and waits for a forced fresh catalog', async () => {
    const f = fixture();
    try {
      await f.service.refreshNow();
      await f.service.getModelCatalog(true);
      expect(f.server.close).toHaveBeenCalledTimes(1);
      expect(OpenCodeServer).toHaveBeenCalledTimes(2);
      expect(f.client.provider.list).toHaveBeenCalledTimes(2);
    } finally {
      f.service.onModuleDestroy();
    }
  });

  it('retains the last working models when refresh fails', async () => {
    const f = fixture();
    try {
      await f.service.refreshNow();
      const original = await f.service.getModelCatalog();
      f.server.start.mockRejectedValueOnce(new Error('CLI is updating'));
      const refreshed = await f.service.getModelCatalog(true);
      expect(refreshed.models).toEqual(original.models);
      expect(refreshed.unavailableReason).toContain('CLI is updating');
    } finally {
      f.service.onModuleDestroy();
    }
  });
  it('coalesces catalog refresh and obtains models from the native provider', async () => {
    const f = fixture();
    try {
      await Promise.all([f.service.refreshNow(), f.service.refreshNow()]);
      expect(f.client.provider.list).toHaveBeenCalledTimes(1);
      expect((await f.service.getModelCatalog()).models[0].id).toBe(
        'local/model',
      );
      expect(await f.service.getAuthStatus()).toMatchObject({
        installed: true,
        authenticated: true,
        version: '2',
      });
    } finally {
      f.service.onModuleDestroy();
    }
  });
  it('stores keys through OpenCode and reloads locations before reporting success', async () => {
    const f = fixture();
    try {
      await f.service.startLogin({
        mode: 'api_key',
        apiKeyProvider: 'local',
        apiKey: ' test-key ',
      });
      expect(f.client.auth.set).toHaveBeenCalledWith({
        providerID: 'local',
        auth: { type: 'api', key: 'test-key' },
      });
      expect(f.client.instance.dispose).toHaveBeenCalled();
      expect(await f.service.getAuthStatus()).toMatchObject({
        authenticated: true,
      });
    } finally {
      f.service.onModuleDestroy();
    }
  });
  it('completes manual-code OAuth and can cancel a pending native attempt', async () => {
    const f = fixture();
    try {
      expect(
        await f.service.startLogin({ mode: 'oauth', oauthProvider: 'local' }),
      ).toMatchObject({
        authUrl: 'https://example.org/login',
        supportsManualCode: true,
      });
      await f.service.continueLogin({ code: 'code' });
      expect(f.client.provider.oauth.callback).toHaveBeenCalledWith(
        { providerID: 'local', method: 1, code: 'code' },
        expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
      );
      await f.service.startLogin({ mode: 'oauth', oauthProvider: 'local' });
      await f.service.cancelLogin();
      expect(f.client.cancelOAuth).toHaveBeenCalled();
      expect(await f.service.getAuthStatus()).toMatchObject({
        isAuthenticating: false,
      });
    } finally {
      f.service.onModuleDestroy();
    }
  });
});
