import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  ChildProcess,
  execFile as execFileCallback,
  spawn,
} from 'child_process';
import type { Readable } from 'stream';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { buildAugmentedEnv, findBinary } from '../config/system-paths.js';
import type {
  CodexAuthStatus,
  CodexLoginMode,
  CodexLoginStartResult,
} from './codex-runtime.types.js';

const execFile = promisify(execFileCallback);
// Match an http(s) URL — strip trailing punctuation/ANSI separators codex
// occasionally adds when wrapping its output.
const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;
// Device codes are uppercase letters/digits, typically formatted XXXX-XXXXX.
// Codex prints the code on a line by itself.
const USER_CODE_PATTERN = /\b([A-Z0-9]{3,6}-[A-Z0-9]{3,6})\b/;
const LOGIN_URL_TIMEOUT_MS = 15_000;
// Strip ANSI escape sequences from codex's TTY output.
const ANSI_PATTERN = /\[[0-9;?]*[ -\/]*[@-~]/g;

interface ActiveLogin {
  mode: CodexLoginMode;
  child: ChildProcess;
  url: string | null;
  userCode: string | null;
  output: string[];
}

@Injectable()
export class CodexAuthService extends EventEmitter {
  private readonly logger = new Logger('CodexAuthService');
  private readonly authPath = join(homedir(), '.codex', 'auth.json');
  private active: ActiveLogin | null = null;
  private lastError: string | null = null;

  async getStatus(): Promise<CodexAuthStatus> {
    const [version, authFile] = await Promise.all([
      this.readVersion(),
      this.readAuthFile(),
    ]);
    const tokens = asRecord(authFile?.tokens);
    const idToken = stringValue(tokens?.id_token);
    const accessToken = stringValue(tokens?.access_token);
    const apiKey = stringValue(authFile?.OPENAI_API_KEY);
    const email = idToken ? this.extractJwtEmail(idToken) : undefined;
    const authenticated = Boolean(idToken || accessToken || apiKey);
    const authMethod = idToken || accessToken ? 'oauth' : apiKey ? 'api_key' : 'none';
    const active = this.active;
    const output = [
      version ? `codex ${version}` : 'Codex CLI not found',
      authenticated
        ? authMethod === 'oauth'
          ? `Signed in${email ? ` as ${email}` : ''}`
          : 'OPENAI_API_KEY configured'
        : 'No Codex credentials found',
    ];
    if (active) {
      output.push(
        active.mode === 'oauth'
          ? active.url && active.userCode
            ? `Visit ${active.url} and enter code ${active.userCode}`
            : active.url
              ? 'Waiting for browser sign-in…'
              : 'Starting Codex login…'
          : 'Saving API key…',
      );
    }
    if (this.lastError && !active) {
      output.push(this.lastError);
    }

    return {
      isAuthenticating: Boolean(active),
      output,
      installed: Boolean(version),
      version,
      authenticated,
      authMethod,
      email,
      authPath: this.authPath,
      loginMode: active?.mode ?? null,
      loginUrl: active?.url ?? null,
      loginUserCode: active?.userCode ?? null,
      loginError: active ? null : this.lastError,
    };
  }

  async startLogin(
    options: { mode: CodexLoginMode; apiKey?: string } = { mode: 'oauth' },
  ): Promise<CodexLoginStartResult> {
    // If a previous login is still around (e.g. the user reloaded or the
    // backend outlived the last attempt), take it down so they can retry
    // instead of being locked out.
    if (this.active) {
      await this.killActive();
    }
    const codexBin = findBinary('codex') ?? 'codex';
    if (!findBinary('codex')) {
      try {
        await execFile(codexBin, ['--version'], {
          env: buildAugmentedEnv(),
          timeout: 5000,
        });
      } catch {
        throw new BadRequestException(
          'Codex CLI not found. Install it with `npm install -g @openai/codex` or `brew install codex`.',
        );
      }
    }

    if (options.mode === 'api_key') {
      const apiKey = (options.apiKey ?? '').trim();
      if (!apiKey) {
        throw new BadRequestException('API key cannot be empty.');
      }
      return this.runApiKeyLogin(codexBin, apiKey);
    }

    return this.runOauthLogin(codexBin);
  }

  async cancelLogin(): Promise<CodexAuthStatus> {
    if (this.active) {
      await this.killActive();
    }
    return this.getStatus();
  }

  private async killActive(): Promise<void> {
    const previous = this.active;
    if (!previous) return;
    // Detach state immediately so a follow-up startLogin can proceed without
    // racing the child's exit event.
    this.active = null;
    const { child } = previous;
    if (child.exitCode !== null || child.killed) return;

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    const escalate = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // process may already be gone
      }
    }, 500);
    await Promise.race([
      exited,
      new Promise<void>((r) => setTimeout(r, 1500)),
    ]);
    clearTimeout(escalate);
  }

  private runOauthLogin(codexBin: string): Promise<CodexLoginStartResult> {
    // Use the device-auth flow so the OAuth handshake doesn't depend on the
    // user's browser being able to reach the backend's localhost callback —
    // this is the only path that works for remote/SSH installs and it also
    // works locally.
    const child = spawn(codexBin, ['login', '--device-auth'], {
      env: { ...buildAugmentedEnv(), BROWSER: '/bin/true', DISPLAY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const active: ActiveLogin = {
      mode: 'oauth',
      child,
      url: null,
      userCode: null,
      output: [],
    };
    this.active = active;
    this.lastError = null;
    this.emitChanged();

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8');
      active.output.push(text);
      const clean = text.replace(ANSI_PATTERN, '');
      let changed = false;
      if (!active.url) {
        const match = clean.match(URL_PATTERN);
        if (match) {
          active.url = match[0].replace(/[.,;:)\]>]+$/, '');
          changed = true;
        }
      }
      if (!active.userCode) {
        const match = clean.match(USER_CODE_PATTERN);
        if (match) {
          active.userCode = match[1];
          changed = true;
        }
      }
      if (changed) {
        this.emitChanged();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.once('error', (error) => {
      this.logger.error(`codex login failed to spawn: ${String(error)}`);
      this.lastError = error instanceof Error ? error.message : String(error);
      if (this.active === active) {
        this.active = null;
      }
      this.emitChanged();
    });

    child.once('exit', (code) => {
      const wasActive = this.active === active;
      const combined = active.output.join('').replace(ANSI_PATTERN, '').trim();
      if (code === 0) {
        this.lastError = null;
      } else if (code !== null) {
        this.lastError = combined.split('\n').filter(Boolean).pop()
          ?? `codex login exited with code ${code}`;
      }
      if (wasActive) {
        this.active = null;
      }
      this.emitChanged();
    });

    return new Promise<CodexLoginStartResult>((resolve, reject) => {
      const ready = (): boolean => Boolean(active.url && active.userCode);
      const timer = setTimeout(() => {
        cleanup();
        if (ready()) {
          resolve(this.toStartResult(active));
        } else {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
          reject(
            new BadRequestException(
              'Codex login did not return a verification code in time.',
            ),
          );
        }
      }, LOGIN_URL_TIMEOUT_MS);

      const watchReady = (): void => {
        if (ready()) {
          cleanup();
          resolve(this.toStartResult(active));
        }
      };
      const watchExit = (): void => {
        cleanup();
        if (ready()) {
          resolve(this.toStartResult(active));
        } else {
          reject(
            new BadRequestException(
              this.lastError ?? 'codex login exited before producing a verification code.',
            ),
          );
        }
      };

      const interval = setInterval(watchReady, 50);
      child.once('exit', watchExit);
      const cleanup = (): void => {
        clearTimeout(timer);
        clearInterval(interval);
        child.removeListener('exit', watchExit);
      };
    });
  }

  private async runApiKeyLogin(
    codexBin: string,
    apiKey: string,
  ): Promise<CodexLoginStartResult> {
    const child = spawn(codexBin, ['login', '--with-api-key'], {
      env: buildAugmentedEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const active: ActiveLogin = {
      mode: 'api_key',
      child,
      url: null,
      userCode: null,
      output: [],
    };
    this.active = active;
    this.lastError = null;
    this.emitChanged();

    const onData = (chunk: Buffer): void => {
      active.output.push(chunk.toString('utf-8'));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.stdin?.write(`${apiKey}\n`);
    child.stdin?.end();

    return new Promise<CodexLoginStartResult>((resolve, reject) => {
      child.once('error', (error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        if (this.active === active) {
          this.active = null;
        }
        this.emitChanged();
        reject(new BadRequestException(this.lastError));
      });
      child.once('exit', (code) => {
        const combined = active.output.join('').trim();
        const wasActive = this.active === active;
        if (wasActive) {
          this.active = null;
        }
        if (code === 0) {
          this.lastError = null;
          this.emitChanged();
          resolve({
            mode: 'api_key',
            authUrl: null,
            userCode: null,
            message: 'OPENAI_API_KEY saved.',
          });
        } else {
          this.lastError = combined.split('\n').filter(Boolean).pop()
            ?? `codex login --with-api-key exited with code ${code}`;
          this.emitChanged();
          reject(new BadRequestException(this.lastError));
        }
      });
    });
  }

  private toStartResult(active: ActiveLogin): CodexLoginStartResult {
    return {
      mode: active.mode,
      authUrl: active.url,
      userCode: active.userCode,
      message:
        active.mode === 'oauth'
          ? active.userCode
            ? `Open the link and enter the code ${active.userCode}.`
            : 'Sign in to OpenAI in your browser, then return here.'
          : 'API key saved.',
    };
  }

  private emitChanged(): void {
    void this.getStatus()
      .then((status) => this.emit('status', status))
      .catch(() => undefined);
  }

  private async readVersion(): Promise<string | null> {
    const codexBin = findBinary('codex') ?? 'codex';
    try {
      const { stdout } = await execFile(codexBin, ['--version'], {
        encoding: 'utf-8',
        env: buildAugmentedEnv(),
        timeout: 5000,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async readAuthFile(): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(await fs.readFile(this.authPath, 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  }

  private extractJwtEmail(token: string): string | undefined {
    const payload = token.split('.')[1];
    if (!payload) {
      return undefined;
    }
    try {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const parsed = JSON.parse(
        Buffer.from(normalized, 'base64').toString('utf-8'),
      ) as Record<string, unknown>;
      return stringValue(parsed.email) ?? stringValue(parsed.user);
    } catch {
      return undefined;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
