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
