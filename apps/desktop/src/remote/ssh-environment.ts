import { spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * OpenSSH runs ProxyCommand, Match exec, KnownHostsCommand and similar config
 * hooks through the user's shell with the client's environment. An app opened
 * from Finder, the Dock or a launcher inherits launchd's minimal environment
 * instead of a terminal's, so tools such as `workspaces`, `cloudflared` or a
 * Homebrew `nc` are missing and a config that works in a terminal fails here.
 * A terminal connection only seemed to fix it because the app then reused its
 * ControlMaster. Capture the login shell's environment once and run SSH with it.
 */
export interface SshEnvironmentOptions {
  readonly inherited?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Bounds a slow or hanging rc file; SSH then falls back to the inherited environment. */
  readonly timeoutMs?: number;
  /** Later reads use the cached capture immediately and refresh it in the background. */
  readonly maxAgeMs?: number;
  readonly now?: () => number;
  readonly capture?: (inherited: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal) => Promise<NodeJS.ProcessEnv | undefined>;
}

const START = '>>>ELEVENEX_SSH_ENV<<<';
const END = '>>>ELEVENEX_SSH_ENV_END<<<';
const OUTPUT_LIMIT = 1024 * 1024;
// Values that describe the capture shell itself rather than the user's setup.
const SHELL_LOCAL = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);

/** Application-scoped: the creator calls dispose() at shutdown. */
export class SshEnvironment {
  private readonly inherited: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly capture: NonNullable<SshEnvironmentOptions['capture']>;
  private readonly lifetime = new AbortController();
  private captured: { readonly shell: NodeJS.ProcessEnv; readonly at: number } | undefined;
  private pending: Promise<NodeJS.ProcessEnv> | undefined;

  constructor(options: SshEnvironmentOptions = {}) {
    this.inherited = options.inherited ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAgeMs = options.maxAgeMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.capture = options.capture ?? captureLoginShell;
  }

  /** The environment for one SSH client; waits only for the first capture. */
  async read(signal: AbortSignal): Promise<NodeJS.ProcessEnv> {
    // Windows GUI apps receive the user's registry environment; there is no login shell to replay.
    if (this.platform === 'win32') return { ...this.inherited };
    const cached = this.captured;
    if (!cached || this.now() - cached.at >= this.maxAgeMs) this.refresh();
    const shell = cached?.shell ?? await abortable(this.pending ?? Promise.resolve({}), signal);
    return mergeSshEnvironment(this.inherited, shell, this.platform);
  }

  /** Starts the first capture early so a connection made right after launch does not wait for rc files. */
  warm(): void { if (this.platform !== 'win32' && !this.captured) this.refresh(); }

  dispose(): void { this.lifetime.abort(); }

  private refresh(): void {
    if (this.pending || this.lifetime.signal.aborted) return;
    this.pending = this.capture(this.inherited, this.timeoutMs, this.lifetime.signal)
      .catch(() => undefined)
      .then(shell => {
        // A failed capture is remembered too, so later connections do not each wait for the timeout.
        const result = shell ?? this.captured?.shell ?? {};
        this.captured = { shell: result, at: this.now() };
        this.pending = undefined;
        return result;
      });
  }
}

/** The shell started from the inherited environment, so a changed value is one the user's rc files set. */
export function mergeSshEnvironment(inherited: NodeJS.ProcessEnv, shell: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...inherited };
  for (const [key, value] of Object.entries(shell)) if (value !== undefined && !SHELL_LOCAL.has(key)) merged[key] = value;
  // The terminal's order wins so SSH finds the same tools; inherited entries and
  // common install locations still cover a capture that failed or timed out.
  const common = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : ['/usr/local/bin'];
  const entries = [shell['PATH'], inherited['PATH'], [...common, join(homedir(), '.local', 'bin'), '/usr/bin', '/bin'].join(':')]
    .flatMap(path => path?.split(':') ?? []).filter(Boolean);
  merged['PATH'] = [...new Set(entries)].join(':');
  return merged;
}

/** Runs the user's interactive login shell once and reads its exported environment. */
export function captureLoginShell(inherited: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<NodeJS.ProcessEnv | undefined> {
  const env: NodeJS.ProcessEnv = { ...inherited };
  delete env['ELECTRON_RUN_AS_NODE']; delete env['NODE_OPTIONS']; delete env['NODE_PATH'];
  const shell = env['SHELL']?.trim() || accountShell();
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    // -i reads .zshrc/.bashrc, where many users extend PATH; stdin stays closed
    // so a prompt in an rc file cannot wait for input.
    const child = spawn(shell, ['-i', '-l', '-c', `printf '%s' '${START}'; /usr/bin/env -0 && printf '%s' '${END}'`],
      { cwd: homedir(), env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (result: NodeJS.ProcessEnv | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      // The capture owns its process group, including rc-file descendants holding stdout open.
      if (result === undefined && child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      child.stdout.destroy();
      resolve(result);
    };
    const aborted = () => finish(undefined);
    const timer = setTimeout(aborted, timeoutMs);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    child.once('error', aborted);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) aborted(); else chunks.push(chunk);
    });
    child.once('close', code => finish(code === 0 ? parseEnvironment(Buffer.concat(chunks).toString('utf8')) : undefined));
  });
}

export function parseEnvironment(output: string): NodeJS.ProcessEnv | undefined {
  // Markers skip banners printed by rc files and logout hooks; env -0 ends
  // every entry with NUL, which cannot occur inside a value.
  const start = output.indexOf(START);
  const end = start === -1 ? -1 : output.indexOf(`\0${END}`, start);
  if (end === -1) return undefined;
  const parsed: NodeJS.ProcessEnv = {};
  for (const entry of output.slice(start + START.length, end).split('\0')) {
    const separator = entry.indexOf('=');
    const key = entry.slice(0, separator);
    if (separator > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) parsed[key] = entry.slice(separator + 1);
  }
  return Object.keys(parsed).length ? parsed : undefined;
}

function accountShell(): string {
  // Only reached when SHELL is unset; a single local account lookup at first connection.
  try { const shell = userInfo().shell; if (shell) return shell; } catch { /* no passwd entry */ }
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
