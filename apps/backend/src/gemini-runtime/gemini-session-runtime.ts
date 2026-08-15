import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildAugmentedEnvAsync } from '../config/system-paths.js';
import {
  AcpConnection,
  ACP_ERROR_METHOD_NOT_FOUND,
  type AcpIncomingNotification,
  type AcpIncomingRequest,
} from './gemini-acp-connection.js';
import {
  buildGeminiSpawnCommand,
  GEMINI_ACP_FLAG,
  GEMINI_TRUST_FLAG,
} from './gemini-binary.js';
import {
  ACP_PROTOCOL_VERSION,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
} from './gemini-runtime.types.js';

const INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** A turn can legitimately run for a long time; only give up after 30 minutes. */
const PROMPT_TIMEOUT_MS = 30 * 60_000;

/**
 * Resolves an ACP path against the session worktree and refuses anything that
 * escapes it. ACP paths are absolute by spec, but a compromised or buggy agent
 * must not be able to read `~/.ssh` through the filesystem capability Elevenex
 * advertises, so containment is enforced rather than trusted.
 */
export function resolveWithinWorktree(cwd: string, rawPath: unknown): string {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('A file path is required.');
  }
  const decoded = rawPath.startsWith('file://')
    ? fileURLToPath(rawPath)
    : rawPath;
  const root = resolve(cwd);
  const target = isAbsolute(decoded)
    ? resolve(decoded)
    : resolve(root, decoded);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `Refusing to access a path outside the session worktree: ${decoded}`,
    );
  }
  return target;
}

export interface GeminiMcpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: { name: string; value: string }[];
  url?: string;
  headers?: { name: string; value: string }[];
  type?: 'http' | 'sse';
}

/**
 * Owns one `gemini --acp` child process and speaks ACP to it.
 *
 * One process per Elevenex session rather than one shared server: ACP fixes
 * `cwd` at `session/new`, and Elevenex sessions live in different worktrees.
 *
 * Emits:
 * - `session_update`     — `AcpSessionNotification` (transcript firehose)
 * - `permission_request` — `{ id, params }` awaiting `respondPermission`
 * - `exit`               — the child went away unexpectedly
 */
export class GeminiSessionRuntime extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: AcpConnection | null = null;
  private startPromise: Promise<AcpInitializeResult> | null = null;
  private initializeResult: AcpInitializeResult | null = null;
  private stderr = '';
  private stopped = false;
  private exited = false;

  constructor(
    private readonly options: {
      cwd: string;
      /** Extra env applied on top of the augmented shell env (e.g. API keys). */
      env?: Record<string, string>;
    },
  ) {
    super();
  }

  get agentCapabilities(): AcpInitializeResult['agentCapabilities'] {
    return this.initializeResult?.agentCapabilities;
  }

  get authMethods(): AcpInitializeResult['authMethods'] {
    return this.initializeResult?.authMethods ?? [];
  }

  get version(): string | null {
    return this.initializeResult?.agentInfo?.version ?? null;
  }

  get isRunning(): boolean {
    return Boolean(this.child) && !this.exited;
  }

  getStderr(): string {
    return this.stderr;
  }

  /** Spawns the child (once) and completes the ACP handshake. */
  async start(): Promise<AcpInitializeResult> {
    if (this.initializeResult) return this.initializeResult;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.spawnAndInitialize().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async spawnAndInitialize(): Promise<AcpInitializeResult> {
    this.stopped = false;
    this.exited = false;

    const env = await buildAugmentedEnvAsync(process.env, this.options.cwd);
    if (this.stopped) throw new Error('Gemini runtime was stopped.');

    const { command, shell } = buildGeminiSpawnCommand();
    const child = spawn(command, [GEMINI_ACP_FLAG, GEMINI_TRUST_FLAG], {
      cwd: this.options.cwd,
      env: { ...env, ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
    });
    this.child = child;

    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded: gemini is chatty on stderr and a long-lived session would
      // otherwise accumulate this string forever.
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-16_000);
    });

    const connection = new AcpConnection(
      child.stdin,
      child.stdout,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.connection = connection;
    connection.on('request', (request: AcpIncomingRequest) => {
      void this.handleAgentRequest(request);
    });
    connection.on('notification', (notification: AcpIncomingNotification) => {
      this.handleAgentNotification(notification);
    });

    // A child that dies immediately still reports `stdin.writable === true` for
    // a tick, so an in-flight write lands on a broken pipe and fails
    // asynchronously. Node escalates a listener-less stream error to an
    // uncaughtException, which would take the backend down over an unusable
    // optional CLI — treat any stdin failure as the process going away.
    child.stdin.on('error', (error: Error) => this.handleExit(error));
    child.once('error', (error) => this.handleExit(error));
    child.once('exit', (code, signal) => {
      this.handleExit(
        new Error(
          `Gemini ACP process exited${code === null ? '' : ` with code ${code}`}${
            signal ? ` (${signal})` : ''
          }`,
        ),
      );
    });

    try {
      const result = await connection.request<AcpInitializeResult>(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            // Deliberately false: Gemini then runs shell commands with its own
            // execute tool and reports output through `tool_call` content,
            // which is exactly what the workspace renders. Advertising a client
            // terminal would add a second command-execution path for no gain.
            terminal: false,
          },
        },
        INITIALIZE_TIMEOUT_MS,
      );
      this.initializeResult = result;
      return result;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      await this.stop();
      throw new Error(
        `Gemini ACP handshake failed: ${normalized.message}${
          this.stderr.trim() ? ` — ${this.stderr.trim().slice(-500)}` : ''
        }`,
      );
    }
  }

  private requireConnection(): AcpConnection {
    if (!this.connection || this.connection.isClosed) {
      throw new Error('Gemini ACP connection is not available.');
    }
    return this.connection;
  }

  authenticate(methodId: string): Promise<unknown> {
    return this.requireConnection().request('authenticate', { methodId });
  }

  newSession(params: {
    cwd: string;
    mcpServers?: GeminiMcpServerConfig[];
  }): Promise<AcpNewSessionResult> {
    return this.requireConnection().request<AcpNewSessionResult>(
      'session/new',
      { cwd: params.cwd, mcpServers: params.mcpServers ?? [] },
      INITIALIZE_TIMEOUT_MS,
    );
  }

  loadSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: GeminiMcpServerConfig[];
  }): Promise<AcpNewSessionResult | null> {
    return this.requireConnection().request<AcpNewSessionResult | null>(
      'session/load',
      {
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
      },
      INITIALIZE_TIMEOUT_MS,
    );
  }

  prompt(
    sessionId: string,
    blocks: AcpContentBlock[],
  ): Promise<AcpPromptResult> {
    return this.requireConnection().request<AcpPromptResult>(
      'session/prompt',
      { sessionId, prompt: blocks },
      PROMPT_TIMEOUT_MS,
    );
  }

  /** Fire-and-forget per the ACP spec — cancellation is a notification. */
  cancel(sessionId: string): void {
    this.connection?.notify('session/cancel', { sessionId });
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.requireConnection().request('session/set_mode', {
      sessionId,
      modeId,
    });
  }

  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.requireConnection().request('session/set_model', {
      sessionId,
      modelId,
    });
  }

  /** Answers a pending `session/request_permission` call. */
  respondPermission(
    rpcRequestId: number | string,
    outcome: { optionId: string } | { cancelled: true },
  ): void {
    this.connection?.respondToRequest(rpcRequestId, {
      outcome:
        'optionId' in outcome
          ? { outcome: 'selected', optionId: outcome.optionId }
          : { outcome: 'cancelled' },
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    this.connection?.close(new Error('Gemini ACP runtime stopped.'));
    this.connection = null;
    this.initializeResult = null;
    if (!child || child.exitCode !== null || child.killed) return;

    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 1500);
    killTimer.unref?.();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 2500).unref?.()),
    ]);
    clearTimeout(killTimer);
  }

  private handleAgentNotification(notification: AcpIncomingNotification): void {
    if (notification.method === 'session/update') {
      this.emit('session_update', notification.params);
      return;
    }
    this.emit('notification', notification);
  }

  private async handleAgentRequest(request: AcpIncomingRequest): Promise<void> {
    const connection = this.connection;
    if (!connection) return;

    try {
      switch (request.method) {
        case 'session/request_permission':
          // Answered later, once the user decides.
          this.emit('permission_request', {
            id: request.id,
            params: request.params as AcpRequestPermissionParams,
          });
          return;
        case 'fs/read_text_file': {
          const result = await this.readTextFile(request.params);
          connection.respondToRequest(request.id, result);
          return;
        }
        case 'fs/write_text_file': {
          await this.writeTextFile(request.params);
          connection.respondToRequest(request.id, {});
          return;
        }
        default:
          connection.rejectRequest(
            request.id,
            `Unsupported ACP method: ${request.method}`,
            ACP_ERROR_METHOD_NOT_FOUND,
          );
      }
    } catch (error) {
      connection.rejectRequest(
        request.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private resolveWithinWorktree(rawPath: unknown): string {
    return resolveWithinWorktree(this.options.cwd, rawPath);
  }

  private async readTextFile(params: unknown): Promise<{ content: string }> {
    const data = (params ?? {}) as Record<string, unknown>;
    const path = this.resolveWithinWorktree(data['path']);
    const content = await fs.readFile(path, 'utf8');

    const line = typeof data['line'] === 'number' ? data['line'] : null;
    const limit = typeof data['limit'] === 'number' ? data['limit'] : null;
    if (line === null && limit === null) return { content };

    const lines = content.split('\n');
    const start = line && line > 0 ? line - 1 : 0;
    const end = limit && limit > 0 ? start + limit : lines.length;
    return { content: lines.slice(start, end).join('\n') };
  }

  private async writeTextFile(params: unknown): Promise<void> {
    const data = (params ?? {}) as Record<string, unknown>;
    const path = this.resolveWithinWorktree(data['path']);
    const content = typeof data['content'] === 'string' ? data['content'] : '';
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, content, 'utf8');
  }

  private handleExit(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    const child = this.child;
    this.child = null;
    this.connection?.close(error);
    this.connection = null;
    this.initializeResult = null;
    if (!this.stopped) {
      this.emit('exit', {
        message: error.message,
        stderr: this.stderr,
        pid: child?.pid,
      });
    }
  }
}
