import type { OpenCodeClient } from './opencode-client.js';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import type { Model, ProviderAuthMethod } from '@opencode-ai/sdk/v2/client';
import type {
  AgentAuthStatus,
  AgentLoginStartResult,
  AgentProviderModelCatalogPayload,
} from '../agent-runtime/agent-runtime.types.js';
import { OpenCodeServer } from './opencode-server.js';
import { loadOpenCodeModels } from './opencode-model-catalog.js';

@Injectable()
export class OpenCodeCatalogService
  extends EventEmitter
  implements OnModuleInit, OnModuleDestroy
{
  private server: OpenCodeServer | null = null;
  private refresh: Promise<void> | null = null;
  private refreshedAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private login: {
    providerID: string;
    method: number;
    controller: AbortController;
  } | null = null;
  readonly models = new Map<string, Model>();
  private catalog: AgentProviderModelCatalogPayload = {
    models: [],
    reasoningEfforts: [],
    providerDefaultModelId: null,
    supportsModelSelection: true,
    unavailableReason: 'Checking the OpenCode CLI…',
  };
  private status: AgentAuthStatus = {
    isAuthenticating: false,
    output: [],
    installed: false,
    authenticated: false,
    providers: [],
    authMethods: {},
  };

  onModuleInit(): void {
    void this.refreshNow().catch(() => undefined);
  }
  onModuleDestroy(): void {
    this.destroyed = true;
    this.login?.controller.abort();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.server?.close();
  }

  async client(): Promise<OpenCodeClient> {
    if (this.destroyed) throw new Error('OpenCode catalog is closed.');
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.server) {
      this.server = new OpenCodeServer({ cwd: homedir() });
      this.server.on('failure', () => {
        this.server?.close();
        this.server = null;
      });
    }
    this.idleTimer = setTimeout(() => {
      if (!this.login) {
        this.server?.close();
        this.server = null;
      }
    }, 5 * 60_000);
    this.idleTimer.unref();
    return this.server.start();
  }

  getModelCatalog(): Promise<AgentProviderModelCatalogPayload> {
    if (Date.now() - this.refreshedAt > 5 * 60_000)
      void this.refreshNow().catch(() => undefined);
    return Promise.resolve({
      ...this.catalog,
      models: [...this.catalog.models],
    });
  }
  async getAuthStatus(): Promise<AgentAuthStatus> {
    if (Date.now() - this.refreshedAt > 30_000) await this.refreshNow();
    return this.status;
  }

  refreshNow(): Promise<void> {
    if (this.refresh) return this.refresh;
    this.refresh = this.load().finally(() => {
      this.refresh = null;
    });
    return this.refresh;
  }
  private async load(): Promise<void> {
    try {
      const client = await this.client();
      const [loaded, methods, health] = await Promise.all([
        loadOpenCodeModels(client),
        client.provider.auth(),
        client.global.health(),
      ]);
      this.models.clear();
      for (const [id, model] of loaded.models) this.models.set(id, model);
      this.catalog = loaded.catalog;
      this.status = {
        ...this.status,
        installed: true,
        version: health.data?.version ?? null,
        authenticated: loaded.catalog.models.length > 0,
        providers: loaded.providers,
        authMethods: methods.data ?? {},
        error: undefined,
      };
    } catch (error) {
      this.server?.close();
      this.server = null;
      this.models.clear();
      this.status = {
        ...this.status,
        installed: false,
        authenticated: false,
        error: String(error),
      };
      this.catalog = {
        ...this.catalog,
        models: [],
        providerDefaultModelId: null,
        unavailableReason: String(error),
      };
    }
    this.refreshedAt = Date.now();
    this.emit('auth_status', this.status);
  }

  async startLogin(options: {
    mode: 'oauth' | 'api_key';
    apiKey?: string;
    apiKeyProvider?: string;
    oauthProvider?: string;
  }): Promise<AgentLoginStartResult> {
    await this.cancelLogin();
    const client = await this.client();
    const providerID =
      options.mode === 'api_key'
        ? options.apiKeyProvider
        : options.oauthProvider;
    if (!providerID) throw new Error('Choose an OpenCode provider.');
    if (options.mode === 'api_key') {
      if (!options.apiKey?.trim()) throw new Error('An API key is required.');
      await client.auth.set({
        providerID,
        auth: { type: 'api', key: options.apiKey.trim() },
      });
      await client.instance.dispose();
      await this.refreshNow();
      this.emit('credentials_changed');
      return {
        mode: 'api_key',
        authUrl: null,
        userCode: null,
        message: 'OpenCode credentials saved.',
      };
    }
    const methods = (await client.provider.auth()).data?.[providerID] ?? [];
    const method = methods.findIndex(
      (entry: ProviderAuthMethod) =>
        entry.type === 'oauth' && !entry.prompts?.length,
    );
    if (method < 0)
      throw new Error(
        'Use opencode auth login for providers requiring additional setup.',
      );
    const authorization = (
      await client.provider.oauth.authorize({ providerID, method })
    ).data!;
    const login = { providerID, method, controller: new AbortController() };
    this.login = login;
    this.status = {
      ...this.status,
      isAuthenticating: true,
      error: undefined,
      output: [authorization.instructions],
    };
    this.emit('auth_status', this.status);
    if (authorization.method === 'auto')
      void this.completeLogin(login).catch(() => undefined);
    return {
      mode: 'oauth',
      authUrl: authorization.url,
      userCode: null,
      message: authorization.instructions,
      supportsManualCode: authorization.method === 'code',
    };
  }
  async continueLogin(options: { code: string }): Promise<AgentAuthStatus> {
    if (!this.login) throw new Error('No OpenCode login is pending.');
    await this.completeLogin(this.login, options.code);
    return this.status;
  }
  private async completeLogin(
    login: NonNullable<OpenCodeCatalogService['login']>,
    code?: string,
  ): Promise<void> {
    try {
      const client = await this.client();
      await client.provider.oauth.callback(
        {
          providerID: login.providerID,
          method: login.method,
          ...(code ? { code } : {}),
        },
        { signal: login.controller.signal },
      );
      if (this.login !== login) return;
      this.login = null;
      this.status = {
        ...this.status,
        isAuthenticating: false,
        output: ['OpenCode login completed.'],
      };
      await client.instance.dispose();
      await this.refreshNow();
      this.emit('credentials_changed');
    } catch (error) {
      if (this.login !== login) return;
      this.login = null;
      this.status = {
        ...this.status,
        isAuthenticating: false,
        error: String(error),
      };
      this.emit('auth_status', this.status);
      throw error;
    }
  }
  async cancelLogin(): Promise<AgentAuthStatus> {
    this.login?.controller.abort();
    this.login = null;
    if (this.server)
      await this.server
        .start()
        .then((client) => client.cancelOAuth?.())
        .catch(() => undefined);
    this.status = { ...this.status, isAuthenticating: false };
    this.emit('auth_status', this.status);
    return Promise.resolve(this.status);
  }
}
