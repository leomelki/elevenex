import { openCodeMajorVersion } from './opencode-version.js';
import { mergeOpenCodeConfig } from './opencode-config.js';
import { createOpenCodeV2Client } from './opencode-v2-client.js';
import type { OpenCodeClient } from './opencode-client.js';
import { createOpenCodeV1Client } from './opencode-v1-client.js';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@opencode-ai/sdk/v2/client';
import {
  buildAugmentedEnvAsync,
  buildSpawnCommand,
  findBinary,
} from '../config/system-paths.js';

/** Owns one private server. Configuration overrides never write into the user's repo. */
export class OpenCodeServer extends EventEmitter {
  private child: ChildProcess | null = null;
  private starting: Promise<OpenCodeClient> | null = null;
  private client: OpenCodeClient | null = null;
  private readonly lifetime = new AbortController();
  private stopped = false;

  constructor(private readonly options: { cwd: string; config?: Config }) {
    super();
  }

  start(): Promise<OpenCodeClient> {
    if (this.stopped)
      return Promise.reject(new Error('OpenCode server is closed.'));
    if (this.client) return Promise.resolve(this.client);
    if (!this.starting) {
      this.starting = this.launch().catch((error) => {
        this.close();
        throw error;
      });
    }
    return this.starting;
  }

  private async launch(): Promise<OpenCodeClient> {
    const directory = await realpath(this.options.cwd);
    const env = await buildAugmentedEnvAsync(process.env, directory);
    if (this.stopped) throw new Error('OpenCode server is closed.');
    let binary = process.env.OPENCODE_BINARY?.trim() || findBinary('opencode');
    if (!binary) {
      const candidate = join(
        homedir(),
        '.opencode',
        'bin',
        process.platform === 'win32' ? 'opencode.exe' : 'opencode',
      );
      try {
        await access(candidate);
        binary = candidate;
      } catch {
        binary = 'opencode';
      }
    }
    const major = await openCodeMajorVersion(binary, directory, env);
    if (this.stopped) throw new Error('OpenCode server is closed.');
    let overrides: object | undefined = this.options.config;
    if (major >= 2 && this.options.config) {
      overrides = {
        ...(this.options.config.mcp
          ? {
              mcp: {
                servers: Object.fromEntries(
                  Object.entries(this.options.config.mcp)
                    .filter(([, server]) => 'type' in server)
                    .map(([name, server]) => [
                      name,
                      {
                        ...server,
                        disabled:
                          'enabled' in server
                            ? server.enabled === false
                            : false,
                        enabled: undefined,
                      },
                    ]),
                ),
              },
            }
          : {}),
        ...(this.options.config.permission
          ? { permissions: [{ action: '*', resource: '*', effect: 'deny' }] }
          : {}),
      };
    }
    const password = randomBytes(32).toString('hex');
    const command = buildSpawnCommand(binary);
    const child = spawn(
      command.command,
      ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      {
        cwd: directory,
        env: {
          ...env,
          OPENCODE_SERVER_USERNAME: 'opencode',
          OPENCODE_SERVER_PASSWORD: password,
          ...(overrides
            ? {
                OPENCODE_CONFIG_CONTENT: mergeOpenCodeConfig(
                  env.OPENCODE_CONFIG_CONTENT,
                  overrides,
                ),
              }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: command.shell,
      },
    );
    this.child = child;
    const url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error('OpenCode server startup timed out.')),
        20_000,
      );
      const stdout = createInterface({ input: child.stdout });
      const stderr = createInterface({ input: child.stderr });
      const finish = (error?: Error, address?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdout.close();
        stderr.close();
        child.stdout.resume();
        child.stderr.resume();
        if (error) reject(error);
        else resolve(address!);
      };
      const line = (value: string) => {
        // Restrict advertised URLs to our authenticated loopback listener.
        const match = value.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) finish(undefined, match[0]);
      };
      stdout.on('line', line);
      stderr.on('line', line);
      child.once('error', (error) =>
        finish(
          new Error(
            `Cannot start OpenCode: ${error.message}. Install the OpenCode CLI or set OPENCODE_BINARY.`,
          ),
        ),
      );
      child.once('exit', (code) => {
        this.client = null;
        finish(new Error(`OpenCode server exited (${code}).`));
        if (!this.stopped)
          this.emit('failure', new Error(`OpenCode server exited (${code}).`));
      });
      this.lifetime.signal.addEventListener(
        'abort',
        () => finish(new Error('OpenCode server closed.')),
        { once: true },
      );
    });
    if (this.stopped) throw new Error('OpenCode server is closed.');
    // ESM SDK is loaded lazily, preserving CommonJS backend and Electron compatibility.
    const { createOpencodeClient } = await import('@opencode-ai/sdk/v2/client');
    const clientOptions = {
      baseUrl: url,
      directory: directory,
      throwOnError: true,
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const stream = new URL(request.url).pathname.endsWith('/event');
        const signals = [request.signal, this.lifetime.signal];
        // Prompt/command calls complete when the turn ends; permission waits can be long.
        if (
          !stream &&
          !/\/(message|command|shell|callback|wait|prompt)$/.test(
            new URL(request.url).pathname,
          )
        ) {
          signals.push(AbortSignal.timeout(30_000));
        }
        return fetch(request, { signal: AbortSignal.any(signals) });
      },
    };
    if (major >= 2) {
      const { OpenCode } = await import('@opencode/client');
      const native = OpenCode.make(clientOptions);
      await native.location.get({ location: { directory: directory } });
      await native.config.get({ location: { directory: directory } });
      await native.model.default({ location: { directory: directory } });
      this.client = createOpenCodeV2Client(native, directory);
    } else {
      this.client = createOpenCodeV1Client(createOpencodeClient(clientOptions));
    }
    return this.client;
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifetime.abort();
    this.client = null;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3_000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  }
}
