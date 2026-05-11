import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { execFile as execFileCallback } from 'child_process';
import { createServer, type Server } from 'http';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import { buildAugmentedEnv } from '../config/system-paths.js';
import type {
  PiAuthStatus,
  PiOAuthProvider,
  PiApiKeyProvider,
} from './pi-runtime.types.js';
import type { AgentAuthStatus, AgentLoginMode, AgentLoginStartResult } from '../agent-runtime/agent-runtime.types.js';

const execFile = promisify(execFileCallback);
const VERSION_TTL_MS = 60 * 60 * 1000;

// Anthropic OAuth constants (from PI source)
const ANTHROPIC_CLIENT_ID = Buffer.from('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl', 'base64').toString();
const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const ANTHROPIC_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const ANTHROPIC_CALLBACK_PORT = 53692;
const ANTHROPIC_CALLBACK_PATH = '/callback';
const ANTHROPIC_REDIRECT_URI = `http://localhost:${ANTHROPIC_CALLBACK_PORT}${ANTHROPIC_CALLBACK_PATH}`;
const ANTHROPIC_SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

// OpenAI Codex OAuth constants (from PI source)
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_CALLBACK_PORT = 1455;
const OPENAI_CODEX_CALLBACK_PATH = '/auth/callback';
const OPENAI_CODEX_REDIRECT_URI = `http://localhost:${OPENAI_CODEX_CALLBACK_PORT}${OPENAI_CODEX_CALLBACK_PATH}`;
const OPENAI_CODEX_SCOPES = 'openid profile email offline_access';

// GitHub Copilot OAuth constants (from PI source)
const GITHUB_COPILOT_CLIENT_ID = Buffer.from('SXYxLmI1MDdhMDhjODdlY2ZlOTg=', 'base64').toString();
const GITHUB_COPILOT_DOMAIN = 'github.com';
const GITHUB_DEVICE_CODE_URL = `https://${GITHUB_COPILOT_DOMAIN}/login/device/code`;
const GITHUB_ACCESS_TOKEN_URL = `https://${GITHUB_COPILOT_DOMAIN}/login/oauth/access_token`;
const GITHUB_COPILOT_TOKEN_URL = `https://api.${GITHUB_COPILOT_DOMAIN}/copilot_internal/v2/token`;
const GITHUB_COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};

const LOGIN_URL_TIMEOUT_MS = 20_000;

interface PkceActive {
  kind: 'pkce';
  provider: 'anthropic' | 'openai-codex';
  verifier: string;
  authUrl: string;
  callbackServer: Server | null;
  resolvePkce: (code: string) => void;
  rejectPkce: (err: Error) => void;
}

interface DeviceActive {
  kind: 'device';
  provider: 'github-copilot';
  userCode: string;
  authUrl: string;
  abortController: AbortController;
}

interface ApiKeyActive {
  kind: 'api_key';
}

type ActiveLogin = PkceActive | DeviceActive | ApiKeyActive;

type AuthCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number; [key: string]: unknown };

@Injectable()
export class PiAuthService extends EventEmitter {
  private readonly logger = new Logger('PiAuthService');
  private readonly authPath = join(homedir(), '.pi', 'agent', 'auth.json');
  private readonly modelsPath = join(homedir(), '.pi', 'agent', 'models.json');
  private versionCache: { value: string | null; expiresAt: number } | null = null;
  private active: ActiveLogin | null = null;
  private lastError: string | null = null;

  async getStatus(): Promise<PiAuthStatus> {
    const version = await this.readVersion();
    const storedCredentials = await this.readAuthFile();
    const hasStoredCredentials = Object.keys(storedCredentials).length > 0;
    const hasModels = existsSync(this.modelsPath);
    const hasEnvKey = this.hasProviderEnv();
    const authenticated = hasStoredCredentials || hasEnvKey;
    const active = this.active;

    const output: string[] = [
      version ? `pi ${version}` : 'Pi CLI not found',
      authenticated
        ? hasStoredCredentials
          ? `Pi auth configured at ${this.authPath}`
          : 'Provider API key available in environment'
        : 'No Pi credentials found',
      hasModels ? `Models configured at ${this.modelsPath}` : 'No Pi models.json found',
    ];

    if (active) {
      if (active.kind === 'pkce') {
        output.push('Waiting for browser authorization…');
      } else if (active.kind === 'device') {
        output.push(`Enter code ${active.userCode} at the verification page`);
      } else {
        output.push('Saving credentials…');
      }
    } else if (this.lastError) {
      output.push(this.lastError);
    }

    const credentialTypes = Object.values(storedCredentials).map((c) => c?.type);
    const hasOAuthStored = credentialTypes.includes('oauth');
    const hasApiKeyStored = credentialTypes.includes('api_key');
    const authMethod: PiAuthStatus['authMethod'] = !authenticated
      ? 'none'
      : hasOAuthStored && !hasApiKeyStored
        ? 'oauth'
        : 'api_key';

    return {
      isAuthenticating: Boolean(active),
      output,
      installed: Boolean(version),
      version,
      authenticated,
      authMethod,
      authPath: this.authPath,
      modelsPath: this.modelsPath,
      loginMode: active ? (active.kind === 'api_key' ? 'api_key' : 'oauth') : null,
      loginUrl: active && active.kind !== 'api_key' ? active.authUrl : null,
      loginUserCode: active && active.kind === 'device' ? active.userCode : null,
      loginError: active ? null : this.lastError,
    };
  }

  async startLogin(options: {
    mode: AgentLoginMode;
    apiKey?: string;
    oauthProvider?: string;
    apiKeyProvider?: string;
  }): Promise<AgentLoginStartResult> {
    await this.killActive();
    this.lastError = null;

    if (options.mode === 'api_key') {
      return this.runApiKeyLogin(options.apiKeyProvider ?? 'anthropic', options.apiKey ?? '');
    }

    const provider = (options.oauthProvider ?? 'anthropic') as PiOAuthProvider;
    switch (provider) {
      case 'anthropic':
        return this.runPkceLogin('anthropic');
      case 'github-copilot':
        return this.runDeviceLogin();
      case 'openai-codex':
        return this.runPkceLogin('openai-codex');
      default:
        throw new BadRequestException(`Unknown OAuth provider: ${String(provider)}`);
    }
  }

  async cancelLogin(): Promise<AgentAuthStatus> {
    await this.killActive();
    this.lastError = null;
    return this.getStatus();
  }

  async continueLogin(options: { code: string }): Promise<AgentAuthStatus> {
    const active = this.active;
    if (!active || active.kind !== 'pkce') {
      throw new BadRequestException('No active PKCE login to continue.');
    }
    const parsed = this.parseAuthInput(options.code);
    if (!parsed.code) {
      throw new BadRequestException('Could not extract authorization code from input.');
    }
    active.resolvePkce(parsed.code);
    return this.getStatus();
  }

  private async runApiKeyLogin(provider: string, apiKey: string): Promise<AgentLoginStartResult> {
    const key = apiKey.trim();
    if (!key) {
      throw new BadRequestException('API key cannot be empty.');
    }

    this.active = { kind: 'api_key' };
    this.emitChanged();

    try {
      const current = await this.readAuthFile();
      const updated = { ...current, [provider]: { type: 'api_key' as const, key } };
      await this.writeAuthFile(updated);
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.active = null;
      this.emitChanged();
      throw new BadRequestException(this.lastError);
    }

    this.active = null;
    this.emitChanged();

    return {
      mode: 'api_key',
      authUrl: null,
      userCode: null,
      message: `API key saved for ${provider}.`,
    };
  }

  private runPkceLogin(provider: 'anthropic' | 'openai-codex'): Promise<AgentLoginStartResult> {
    const { verifier, challenge } = this.generatePkce();
    const state = randomBytes(16).toString('hex');

    const isAnthropic = provider === 'anthropic';
    const authorizeUrl = isAnthropic ? ANTHROPIC_AUTHORIZE_URL : OPENAI_CODEX_AUTHORIZE_URL;
    const redirectUri = isAnthropic ? ANTHROPIC_REDIRECT_URI : OPENAI_CODEX_REDIRECT_URI;
    const callbackPort = isAnthropic ? ANTHROPIC_CALLBACK_PORT : OPENAI_CODEX_CALLBACK_PORT;
    const callbackPath = isAnthropic ? ANTHROPIC_CALLBACK_PATH : OPENAI_CODEX_CALLBACK_PATH;
    const clientId = isAnthropic ? ANTHROPIC_CLIENT_ID : OPENAI_CODEX_CLIENT_ID;
    const scopes = isAnthropic ? ANTHROPIC_SCOPES : OPENAI_CODEX_SCOPES;

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    if (isAnthropic) {
      params.set('code', 'true');
    }
    const authUrl = `${authorizeUrl}?${params.toString()}`;

    let resolvePkce!: (code: string) => void;
    let rejectPkce!: (err: Error) => void;
    const pkcePromise = new Promise<string>((res, rej) => {
      resolvePkce = res;
      rejectPkce = rej;
    });

    let callbackServer: Server | null = null;
    const tryStartCallbackServer = (): void => {
      try {
        callbackServer = createServer((req, res) => {
          try {
            const url = new URL(req.url ?? '', 'http://localhost');
            if (url.pathname !== callbackPath) {
              res.writeHead(404).end('Not found');
              return;
            }
            const code = url.searchParams.get('code');
            const returnedState = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/html' })
                .end('<h1>Authorization failed</h1><p>You can close this window.</p>');
              rejectPkce(new Error(`OAuth error: ${error}`));
              return;
            }
            if (!code) {
              res.writeHead(400, { 'Content-Type': 'text/html' })
                .end('<h1>Missing code</h1><p>You can close this window.</p>');
              return;
            }
            if (returnedState && returnedState !== state) {
              res.writeHead(400, { 'Content-Type': 'text/html' })
                .end('<h1>State mismatch</h1><p>You can close this window.</p>');
              return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' })
              .end('<h1>Authorization complete</h1><p>You can close this window and return to the app.</p>');
            resolvePkce(code);
          } catch {
            res.writeHead(500).end('Internal error');
          }
        });
        callbackServer.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            this.logger.debug(`Port ${callbackPort} in use, skipping local callback server`);
          } else {
            this.logger.warn(`Callback server error: ${err.message}`);
          }
        });
        callbackServer.listen(callbackPort, '127.0.0.1');
      } catch {
        callbackServer = null;
      }
    };
    tryStartCallbackServer();

    const pkceActive: PkceActive = {
      kind: 'pkce',
      provider,
      verifier,
      authUrl,
      callbackServer,
      resolvePkce,
      rejectPkce,
    };
    this.active = pkceActive;
    this.lastError = null;
    this.emitChanged();

    // Complete the exchange once a code is available from either path
    void pkcePromise.then(async (code) => {
      if (this.active !== pkceActive) return;
      this.active = null;
      pkceActive.callbackServer?.close();
      try {
        const credential = await this.exchangePkceCode(provider, code, verifier, redirectUri, clientId);
        const current = await this.readAuthFile();
        await this.writeAuthFile({ ...current, [provider]: credential });
        this.lastError = null;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.logger.error(`PKCE exchange failed: ${this.lastError}`);
      }
      this.emitChanged();
    }).catch((err: unknown) => {
      if (this.active !== pkceActive) return;
      this.active = null;
      pkceActive.callbackServer?.close();
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emitChanged();
    });

    return Promise.resolve({
      mode: 'oauth' as AgentLoginMode,
      authUrl,
      userCode: null,
      message: `Open the link to authorize ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI Codex'}.`,
      supportsManualCode: true,
    });
  }

  private async runDeviceLogin(): Promise<AgentLoginStartResult> {
    const abortController = new AbortController();

    // Start device flow
    const deviceResponse = await fetch(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...GITHUB_COPILOT_HEADERS,
      },
      body: new URLSearchParams({
        client_id: GITHUB_COPILOT_CLIENT_ID,
        scope: 'read:user',
      }),
      signal: AbortSignal.timeout(LOGIN_URL_TIMEOUT_MS),
    });

    if (!deviceResponse.ok) {
      const text = await deviceResponse.text().catch(() => '');
      throw new BadRequestException(`GitHub device flow failed: ${deviceResponse.status} ${text}`);
    }

    const deviceData = await deviceResponse.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval: number;
      expires_in: number;
    };

    const deviceActive: DeviceActive = {
      kind: 'device',
      provider: 'github-copilot',
      userCode: deviceData.user_code,
      authUrl: deviceData.verification_uri,
      abortController,
    };
    this.active = deviceActive;
    this.lastError = null;
    this.emitChanged();

    // Poll in background
    void this.pollGitHubDeviceFlow(
      deviceActive,
      deviceData.device_code,
      deviceData.interval,
      deviceData.expires_in,
    );

    return {
      mode: 'oauth',
      authUrl: deviceData.verification_uri,
      userCode: deviceData.user_code,
      message: `Enter code ${deviceData.user_code} at the verification page.`,
    };
  }

  private async pollGitHubDeviceFlow(
    active: DeviceActive,
    deviceCode: string,
    intervalSeconds: number,
    expiresIn: number,
  ): Promise<void> {
    const deadline = Date.now() + expiresIn * 1000;
    let intervalMs = Math.max(1000, intervalSeconds * 1000 * 1.2);

    while (Date.now() < deadline) {
      if (active.abortController.signal.aborted || this.active !== active) return;

      await this.sleep(intervalMs, active.abortController.signal);
      if (active.abortController.signal.aborted || this.active !== active) return;

      try {
        const raw = await fetch(GITHUB_ACCESS_TOKEN_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            ...GITHUB_COPILOT_HEADERS,
          },
          body: new URLSearchParams({
            client_id: GITHUB_COPILOT_CLIENT_ID,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await raw.json() as Record<string, unknown>;

        if (typeof data['access_token'] === 'string') {
          const githubToken = data['access_token'];
          if (this.active !== active) return;

          // Exchange for Copilot token
          const copilotResp = await fetch(GITHUB_COPILOT_TOKEN_URL, {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${githubToken}`,
              ...GITHUB_COPILOT_HEADERS,
            },
            signal: AbortSignal.timeout(15_000),
          });
          const copilotData = await copilotResp.json() as Record<string, unknown>;

          if (typeof copilotData['token'] !== 'string' || typeof copilotData['expires_at'] !== 'number') {
            throw new Error('Invalid Copilot token response');
          }

          const credential: AuthCredential = {
            type: 'oauth',
            access: copilotData['token'] as string,
            refresh: githubToken,
            expires: (copilotData['expires_at'] as number) * 1000 - 5 * 60 * 1000,
          };

          if (this.active !== active) return;
          this.active = null;
          const current = await this.readAuthFile();
          await this.writeAuthFile({ ...current, 'github-copilot': credential });
          this.lastError = null;
          this.emitChanged();
          return;
        }

        if (typeof data['error'] === 'string') {
          const error = data['error'] as string;
          if (error === 'authorization_pending') {
            continue;
          }
          if (error === 'slow_down') {
            intervalMs *= 1.4;
            continue;
          }
          throw new Error(`Device flow error: ${error}`);
        }
      } catch (err) {
        if (active.abortController.signal.aborted || this.active !== active) return;
        this.logger.warn(`GitHub Copilot poll error: ${err instanceof Error ? err.message : String(err)}`);
        // Continue polling on transient errors
      }
    }

    if (this.active === active) {
      this.active = null;
      this.lastError = 'GitHub device flow timed out.';
      this.emitChanged();
    }
  }

  private async exchangePkceCode(
    provider: 'anthropic' | 'openai-codex',
    code: string,
    verifier: string,
    redirectUri: string,
    clientId: string,
  ): Promise<AuthCredential> {
    const tokenUrl = provider === 'anthropic' ? ANTHROPIC_TOKEN_URL : OPENAI_CODEX_TOKEN_URL;

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        ...(provider === 'anthropic' ? { state: verifier } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Token exchange failed (${resp.status}): ${text}`);
    }

    const data = await resp.json() as Record<string, unknown>;
    const accessToken = data['access_token'];
    const refreshToken = data['refresh_token'];
    const expiresIn = data['expires_in'];

    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof expiresIn !== 'number') {
      throw new Error(`Token exchange returned unexpected fields: ${JSON.stringify(data)}`);
    }

    return {
      type: 'oauth',
      access: accessToken,
      refresh: refreshToken,
      expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
    };
  }

  private async killActive(): Promise<void> {
    const previous = this.active;
    if (!previous) return;
    this.active = null;

    if (previous.kind === 'pkce') {
      previous.callbackServer?.close();
      previous.rejectPkce(new Error('Login cancelled'));
    } else if (previous.kind === 'device') {
      previous.abortController.abort();
    }
  }

  private generatePkce(): { verifier: string; challenge: string } {
    const verifierBytes = randomBytes(32);
    const verifier = verifierBytes
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const challenge = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    return { verifier, challenge };
  }

  private parseAuthInput(input: string): { code?: string; state?: string } {
    const value = input.trim();
    if (!value) return {};
    try {
      const url = new URL(value);
      return {
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
      };
    } catch {
      // not a URL
    }
    if (value.includes('code=')) {
      const params = new URLSearchParams(value);
      return {
        code: params.get('code') ?? undefined,
        state: params.get('state') ?? undefined,
      };
    }
    return { code: value };
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Aborted')); return; }
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); }, { once: true });
    });
  }

  private emitChanged(): void {
    void this.getStatus()
      .then((status) => this.emit('status', status))
      .catch(() => undefined);
  }

  private async readVersion(): Promise<string | null> {
    const cached = this.versionCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const { stdout } = await execFile('pi', ['--version'], {
        env: buildAugmentedEnv(),
        timeout: 5000,
      });
      const value = stdout.trim().split(/\s+/).pop() || stdout.trim() || null;
      this.versionCache = { value, expiresAt: Date.now() + VERSION_TTL_MS };
      return value;
    } catch {
      this.versionCache = { value: null, expiresAt: Date.now() + VERSION_TTL_MS };
      return null;
    }
  }

  private hasProviderEnv(): boolean {
    return [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
    ].some((name) => Boolean(process.env[name]));
  }

  private async readAuthFile(): Promise<Record<string, AuthCredential>> {
    try {
      const content = await fs.readFile(this.authPath, 'utf-8');
      return JSON.parse(content) as Record<string, AuthCredential>;
    } catch {
      return {};
    }
  }

  private async writeAuthFile(data: Record<string, AuthCredential>): Promise<void> {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    await fs.writeFile(this.authPath, JSON.stringify(data, null, 2), 'utf-8');
    chmodSync(this.authPath, 0o600);
  }
}
