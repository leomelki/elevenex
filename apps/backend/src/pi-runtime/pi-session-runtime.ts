import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import {
  buildAugmentedEnvAsync,
  buildSpawnCommand,
  findBinary,
} from '../config/system-paths.js';
import type {
  PiRpcExtensionUiRequest,
  PiRpcResponse,
  PiSessionRuntimeEvent,
} from './pi-runtime.types.js';

interface PendingRequest {
  command: string;
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class PiSessionRuntime extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 0;
  private stderr = '';
  private stopped = false;
  private exited = false;

  constructor(
    private readonly options: {
      cwd: string;
      sessionPath?: string | null;
      timeoutMs?: number;
    },
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.startProcess().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
  }

  private async startProcess(): Promise<void> {
    if (this.child) return;
    this.stopped = false;
    this.exited = false;
    const args = ['--mode', 'rpc'];
    if (this.options.sessionPath && this.options.sessionPath !== '-1') {
      args.push('--session', this.options.sessionPath);
    }
    const env = await buildAugmentedEnvAsync(process.env, this.options.cwd);
    if (this.stopped || this.child) return;

    // Resolve the real pi binary path. On Windows pi is installed via Volta
    // as a `pi.cmd` batch shim next to an extensionless POSIX `pi` shim that
    // CreateProcess cannot execute. findBinary honours PATHEXT so it picks
    // `pi.cmd`, and buildSpawnCommand sets shell:true so Node (>=18.20, the
    // CVE-2024-27980 mitigation) can launch the batch file. Spawning the bare
    // 'pi' here yields `spawn pi ENOENT` on Windows.
    const { command, shell } = buildSpawnCommand(findBinary('pi') ?? 'pi');
    this.child = spawn(command, args, {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
    });

    this.attachJsonlReader(this.child.stdout, (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
    // A child that dies immediately (missing interpreter for an npm shim, bad
    // install, OOM) still reports `stdin.writable === true` for a tick, so an
    // in-flight write lands on a broken pipe and fails asynchronously. Node
    // escalates a listener-less stream error to an uncaughtException, which
    // would take the whole backend down over an unusable optional CLI, so
    // treat any stdin failure as the process going away.
    this.child.stdin.on('error', (error: Error) => this.handleExit(error));
    this.child.once('error', (error) => this.handleExit(error));
    this.child.once('exit', (code, signal) => {
      this.handleExit(
        new Error(
          `Pi RPC process exited${code === null ? '' : ` with code ${code}`}${
            signal ? ` (${signal})` : ''
          }`,
        ),
      );
    });
  }

  async send<T = unknown>(
    command: Omit<Record<string, unknown>, 'id'> & { type: string },
  ): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new Error('Pi RPC process is not writable.');
    }
    const id = `pi-${++this.nextRequestId}`;
    const payload = { ...command, id };
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const promise = new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC command timed out: ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, { command: command.type, resolve, reject, timer });
    });
    // Reject on write failure instead of letting the caller wait out the full
    // timeout for a reply that can never arrive.
    child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (!error) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    });
    const response = await promise;
    if (!response.success) {
      throw new Error(
        response.error ?? `Pi RPC command failed: ${command.type}`,
      );
    }
    return response.data as T;
  }

  respondToExtensionUi(response: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Pi RPC process stopped.'));
      this.pending.delete(id);
    }
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
        // already exited
      }
    }, 1500);
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
    clearTimeout(killTimer);
  }

  getStderr(): string {
    return this.stderr;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit('event', {
        type: 'error',
        message: `Invalid Pi RPC output: ${line.slice(0, 200)}`,
      });
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const obj = parsed as Record<string, unknown>;
    if (obj.type === 'response') {
      const response = obj as unknown as PiRpcResponse;
      const id = typeof response.id === 'string' ? response.id : '';
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(response);
      return;
    }
    if (obj.type === 'extension_ui_request') {
      this.emit('extension_ui_request', obj);
      return;
    }
    this.emit('event', obj);
  }

  private handleExit(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    const child = this.child;
    this.child = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (!this.stopped) {
      this.emit('exit', {
        message: error.message,
        stderr: this.stderr,
        pid: child?.pid,
      });
    }
  }

  private attachJsonlReader(
    stream: NodeJS.ReadableStream,
    onLine: (line: string) => void,
  ): void {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      while (true) {
        const index = buffer.indexOf('\n');
        if (index === -1) break;
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        onLine(line);
      }
    });
    stream.on('end', () => {
      buffer += decoder.end();
      if (buffer) onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    });
  }
}
