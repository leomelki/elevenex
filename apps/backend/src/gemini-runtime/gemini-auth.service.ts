import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { execFile as execFileCallback } from 'child_process';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { buildGeminiSpawnCommand } from './gemini-binary.js';
import { GeminiSessionRuntime } from './gemini-session-runtime.js';
import type {
  AcpAuthMethod,
  GeminiAuthStatus,
} from './gemini-runtime.types.js';
import type {
  AgentAuthStatus,
  AgentLoginMode,
  AgentLoginStartResult,
} from '../agent-runtime/agent-runtime.types.js';

const execFile = promisify(execFileCallback);

const VERSION_TTL_MS = 60 * 60 * 1000;
/**
 * Authentication is probed by asking the CLI to open a session, which costs a
 * process spawn. Short enough that a fresh login shows up quickly, long enough
 * that status polling from several open tabs doesn't spawn a process per poll.
 */
const PROBE_TTL_MS = 60 * 1000;

const INSTALL_HINT = 'Install it with: npm install -g @google/gemini-cli';

/** Env vars that, when present, mean Gemini already has a usable credential. */
const CREDENTIAL_ENV_VARS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
] as const;

interface ProbeResult {
  authenticated: boolean;
  authMethods: AcpAuthMethod[];
  version: string | null;
  error: string | null;
}

interface ActiveOAuthLogin {
  runtime: GeminiSessionRuntime;
  methodId: string;
  startedAt: number;
}

/**
 * Tracks whether the Gemini CLI is installed and has usable credentials.
 *
 * Credential *storage* is deliberately not modelled: gemini-cli has moved its
 * on-disk layout between releases (0.55 keeps config under `~/.gemini/config/`)
 * and supports four different auth methods. Instead of guessing file paths,
 * this service asks the CLI itself — it opens an ACP connection and tries to
 * create a session, which is the one signal that means "a prompt would work".
 * The answer is cached with a short TTL and coalesced so concurrent callers
 * share a single probe.
 */
@Injectable()
export class GeminiAuthService extends EventEmitter {
  private readonly logger = new Logger('GeminiAuthService');
  /** Where an api-key login persists the key so future processes see it. */
  private readonly envFilePath = join(homedir(), '.gemini', '.env');

  private versionCache: { value: string | null; expiresAt: number } | null =
    null;
  private probeCache: { value: ProbeResult; expiresAt: number } | null = null;
  private probeInFlight: Promise<ProbeResult> | null = null;
  private active: ActiveOAuthLogin | null = null;
  private lastError: string | null = null;

  async getStatus(): Promise<GeminiAuthStatus> {
    const probe = await this.probe();
    const active = this.active;
    const installed = Boolean(probe.version);

    const output: string[] = [
      installed ? `gemini ${probe.version}` : 'Gemini CLI not found',
    ];
    if (!installed) {
      output.push(INSTALL_HINT);
    } else {
      output.push(
        probe.authenticated
          ? 'Gemini credentials are configured'
          : 'No Gemini credentials found',
      );
    }
    if (active) {
      output.push('Waiting for browser authorization…');
    } else if (this.lastError) {
      output.push(this.lastError);
    } else if (probe.error) {
      output.push(probe.error);
    }

    return {
      isAuthenticating: Boolean(active),
      output,
      installed,
      version: probe.version,
      authenticated: probe.authenticated,
      authMethod: this.resolveAuthMethod(probe.authenticated),
      authPath: this.envFilePath,
      availableMethods: probe.authMethods,
      loginMode: active ? 'oauth' : null,
      loginUrl: null,
      loginUserCode: null,
      loginError: active ? null : this.lastError,
      installHint: installed ? null : INSTALL_HINT,
    };
  }

  async startLogin(options: {
    mode: AgentLoginMode;
    apiKey?: string;
    oauthProvider?: string;
    apiKeyProvider?: string;
  }): Promise<AgentLoginStartResult> {
    await this.cancelActive();
    this.lastError = null;

    if (options.mode === 'api_key') {
      return this.runApiKeyLogin(
        options.apiKeyProvider ?? 'gemini-api-key',
        options.apiKey ?? '',
      );
    }
    return this.runOAuthLogin(options.oauthProvider ?? 'oauth-personal');
  }

  async cancelLogin(): Promise<AgentAuthStatus> {
    await this.cancelActive();
    this.lastError = null;
    this.invalidate();
    return this.getStatus();
  }

  continueLogin(): Promise<AgentAuthStatus> {
    // Gemini completes OAuth entirely in the browser and writes the credential
    // itself; there is no code to paste back, unlike Codex's device flow.
    return Promise.reject(
      new BadRequestException(
        'Gemini finishes sign-in in your browser — there is no code to paste back here.',
      ),
    );
  }

  /**
   * Extra environment a session runtime should spawn with. Empty unless an
   * api-key login happened in this process before the key was persisted.
   */
  getRuntimeEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of CREDENTIAL_ENV_VARS) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
    return env;
  }

  /** Drops cached auth/version state, e.g. after a login or a failed prompt. */
  invalidate(): void {
    this.probeCache = null;
    this.emitChanged();
  }

  private resolveAuthMethod(
    authenticated: boolean,
  ): GeminiAuthStatus['authMethod'] {
    if (!authenticated) return 'none';
    if (process.env.GOOGLE_GENAI_USE_VERTEXAI) return 'vertex';
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      return 'api_key';
    }
    return 'oauth';
  }

  private async runApiKeyLogin(
    provider: string,
    apiKey: string,
  ): Promise<AgentLoginStartResult> {
    const key = apiKey.trim();
    if (!key) {
      throw new BadRequestException('An API key is required.');
    }

    const varName =
      provider === 'vertex-ai' ? 'GOOGLE_API_KEY' : 'GEMINI_API_KEY';
    // Apply immediately so an already-running backend can spawn authenticated
    // Gemini processes without waiting for anything to re-read the file.
    process.env[varName] = key;
    if (provider === 'vertex-ai') {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
    }

    try {
      await this.persistEnvVar(varName, key, provider === 'vertex-ai');
    } catch (error) {
      this.logger.warn(
        `Could not persist the Gemini API key to ${this.envFilePath}: ${String(error)}`,
      );
    }

    this.invalidate();
    return {
      mode: 'api_key',
      authUrl: null,
      userCode: null,
      message: 'Gemini API key saved.',
    };
  }

  /**
   * Writes the key to `~/.gemini/.env`, which gemini-cli loads for every
   * invocation, so the credential survives a backend restart. Existing
   * unrelated entries in that file are preserved.
   */
  private async persistEnvVar(
    name: string,
    value: string,
    vertex: boolean,
  ): Promise<void> {
    await fs.mkdir(join(homedir(), '.gemini'), { recursive: true });
    let existing = '';
    try {
      existing = await fs.readFile(this.envFilePath, 'utf8');
    } catch {
      existing = '';
    }

    const updates = new Map<string, string>([[name, value]]);
    if (vertex) updates.set('GOOGLE_GENAI_USE_VERTEXAI', 'true');

    const lines = existing.split(/\r?\n/);
    const kept = lines.filter((line) => {
      const key = line.split('=')[0]?.trim();
      return !key || !updates.has(key);
    });
    const appended = [...updates].map(([key, val]) => `${key}=${val}`);
    const next = [...kept.filter((line) => line.trim()), ...appended].join(
      '\n',
    );
    await fs.writeFile(this.envFilePath, `${next}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  /**
   * Delegates OAuth to the CLI: an ACP `authenticate` call makes gemini open
   * the browser and persist the credential where all its processes find it.
   * The call only settles once the user finishes, so it runs detached and the
   * result is surfaced through status events.
   */
  private async runOAuthLogin(
    methodId: string,
  ): Promise<AgentLoginStartResult> {
    const runtime = new GeminiSessionRuntime({ cwd: tmpdir() });
    try {
      await runtime.start();
    } catch (error) {
      await runtime.stop();
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.emitChanged();
      throw new BadRequestException(
        `Could not start the Gemini CLI for sign-in: ${message}`,
      );
    }

    this.active = { runtime, methodId, startedAt: Date.now() };
    this.emitChanged();

    void runtime
      .authenticate(methodId)
      .then(() => {
        this.lastError = null;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // A cancelled login tears the process down, which rejects the pending
        // call; that is not a failure worth showing the user.
        if (this.active?.runtime === runtime) {
          this.lastError = message;
        }
      })
      .finally(() => {
        if (this.active?.runtime === runtime) {
          this.active = null;
        }
        void runtime.stop();
        this.invalidate();
      });

    return {
      mode: 'oauth',
      authUrl: null,
      userCode: null,
      message:
        'Continue signing in with Google in the browser window Gemini opened.',
      supportsManualCode: false,
    };
  }

  private async cancelActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = null;
    await active.runtime.stop();
    this.emitChanged();
  }

  private async probe(): Promise<ProbeResult> {
    const cached = this.probeCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (this.probeInFlight) return this.probeInFlight;

    this.probeInFlight = this.runProbe()
      .then((value) => {
        this.probeCache = { value, expiresAt: Date.now() + PROBE_TTL_MS };
        return value;
      })
      .finally(() => {
        this.probeInFlight = null;
      });
    return this.probeInFlight;
  }

  private async runProbe(): Promise<ProbeResult> {
    const version = await this.readVersion();
    if (!version) {
      return {
        authenticated: false,
        authMethods: [],
        version: null,
        error: `Gemini CLI not found. ${INSTALL_HINT}`,
      };
    }

    const runtime = new GeminiSessionRuntime({ cwd: tmpdir() });
    try {
      const info = await runtime.start();
      const authMethods = info.authMethods ?? [];
      try {
        // Creating a session is the cheapest call that fails when no usable
        // credential exists, and it succeeds for every auth method (OAuth,
        // API key, Vertex, gateway) without us knowing which one is in play.
        await runtime.newSession({ cwd: tmpdir() });
        return { authenticated: true, authMethods, version, error: null };
      } catch (error) {
        return {
          authenticated: false,
          authMethods,
          version,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } catch (error) {
      return {
        authenticated: false,
        authMethods: [],
        version,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await runtime.stop();
    }
  }

  private async readVersion(): Promise<string | null> {
    const cached = this.versionCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value: string | null = null;
    try {
      const { command, shell } = buildGeminiSpawnCommand();
      const { stdout } = await execFile(command, ['--version'], {
        shell,
        timeout: 15_000,
        windowsHide: true,
      });
      const trimmed = stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
      value = trimmed || null;
    } catch {
      value = null;
    }

    this.versionCache = { value, expiresAt: Date.now() + VERSION_TTL_MS };
    return value;
  }

  private emitChanged(): void {
    void this.getStatus()
      .then((status) => this.emit('status', status))
      .catch(() => undefined);
  }
}
