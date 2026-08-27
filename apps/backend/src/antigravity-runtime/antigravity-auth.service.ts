import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { execFile as execFileCallback } from 'child_process';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import { buildAntigravitySpawnCommand } from './antigravity-binary.js';
import type { AntigravityAuthStatus } from './antigravity-runtime.types.js';
import type {
  AgentAuthStatus,
  AgentLoginMode,
  AgentLoginStartResult,
} from '../agent-runtime/agent-runtime.types.js';

const execFile = promisify(execFileCallback);

const VERSION_TTL_MS = 60 * 60 * 1000;

const INSTALL_HINT =
  'Install the Antigravity CLI: https://antigravity.google/docs/cli/getting-started/';

const NOT_YET_SUPPORTED =
  'In-app sign-in for Antigravity is not available yet. Run `agy` once from a terminal in this worktree to sign in — Elevenex will pick up the credential the CLI stores.';

/**
 * Tracks whether the Antigravity CLI (`agy`) is installed.
 *
 * Unlike `GeminiAuthService`, this cannot probe "is a prompt authenticated"
 * cheaply: Gemini's probe worked by opening an ACP session, which `agy`'s
 * headless protocol has no equivalent for, and running a real turn just to
 * check auth would cost a model call. Until `agy`'s own login/auth-status
 * surface is confirmed against a live install, this only reports whether the
 * binary is installed and points the user at running `agy` interactively —
 * see the "Not confirmed" section in docs/antigravity-provider-flow.md.
 */
@Injectable()
export class AntigravityAuthService extends EventEmitter {
  private readonly logger = new Logger('AntigravityAuthService');

  private versionCache: { value: string | null; expiresAt: number } | null =
    null;

  async getStatus(): Promise<AntigravityAuthStatus> {
    const version = await this.readVersion();
    const installed = version !== null;

    const output: string[] = [
      installed ? `agy ${version}` : 'Antigravity CLI not found',
    ];
    output.push(installed ? NOT_YET_SUPPORTED : INSTALL_HINT);

    return {
      isAuthenticating: false,
      output,
      installed,
      version,
      // Not knowable without a live probe surface — see class doc comment.
      authenticated: false,
      authPath: '',
      installHint: installed ? null : INSTALL_HINT,
    };
  }

  startLogin(_options: {
    mode: AgentLoginMode;
    apiKey?: string;
    oauthProvider?: string;
    apiKeyProvider?: string;
  }): Promise<AgentLoginStartResult> {
    return Promise.reject(new BadRequestException(NOT_YET_SUPPORTED));
  }

  cancelLogin(): Promise<AgentAuthStatus> {
    return Promise.reject(new BadRequestException(NOT_YET_SUPPORTED));
  }

  continueLogin(): Promise<AgentAuthStatus> {
    return Promise.reject(new BadRequestException(NOT_YET_SUPPORTED));
  }

  /** No known credential env vars yet — see class doc comment. */
  getRuntimeEnv(): Record<string, string> {
    return {};
  }

  invalidate(): void {
    this.versionCache = null;
  }

  private async readVersion(): Promise<string | null> {
    const cached = this.versionCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value: string | null = null;
    try {
      const { command, shell } = buildAntigravitySpawnCommand();
      const { stdout } = await execFile(command, ['--version'], {
        shell,
        timeout: 15_000,
        windowsHide: true,
      });
      const trimmed = stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
      value = trimmed || null;
    } catch (error) {
      this.logger.debug(`agy --version failed: ${String(error)}`);
      value = null;
    }

    this.versionCache = { value, expiresAt: Date.now() + VERSION_TTL_MS };
    return value;
  }
}
