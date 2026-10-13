import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildSpawnCommand, findBinary } from '../config/system-paths.js';

export async function resolveOpenCodeBinary(): Promise<string> {
  const binary = process.env.OPENCODE_BINARY?.trim() || findBinary('opencode');
  if (binary) return binary;
  const candidate = join(homedir(), '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  try { await access(candidate); return candidate; } catch { return 'opencode'; }
}

const versions = new Map<
  string,
  { identity: string | null; result: Promise<number> }
>();
const MAX_CACHED_BINARIES = 32;

/** Explicit reloads also cover launcher scripts whose native target changed. */
export function clearOpenCodeVersionCache(): void {
  versions.clear();
}

/** Reuse version probes until the executable changes, without blocking the event loop. */
export async function openCodeMajorVersion(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let identity: string | null = null;
  try {
    const path = await realpath(binary);
    const file = await stat(path);
    identity = `${path}:${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
  } catch {
    // An unresolved PATH command can still launch, but must not stay cached.
  }
  const key = identity
    ? binary
    : `${binary}\0${cwd}\0${env.PATH ?? env.Path ?? ''}`;
  const cached = versions.get(key);
  if (cached?.identity === identity) return cached.result;
  const result = new Promise<number>((resolve, reject) => {
    const command = buildSpawnCommand(binary);
    const child = spawn(command.command, ['--version'], {
      cwd,
      env,
      shell: command.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('OpenCode version check timed out.'));
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-1000);
    });
    child.stderr.resume();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Cannot start OpenCode: ${error.message}. Install the OpenCode CLI or set OPENCODE_BINARY.`,
        ),
      );
    });
    child.once('exit', () => {
      clearTimeout(timer);
      const version = output.match(/(?:^|\s)v?(\d+)\.\d+\.\d+/);
      if (version) resolve(Number(version[1]));
      else reject(new Error('Could not read the OpenCode CLI version.'));
    });
  });
  versions.set(key, { identity, result });
  if (versions.size > MAX_CACHED_BINARIES) {
    for (const oldest of versions.keys()) {
      versions.delete(oldest);
      break;
    }
  }
  const clear = () => {
    if (versions.get(key)?.result === result) versions.delete(key);
  };
  void result.then(() => {
    if (!identity) clear();
  }, clear);
  return result;
}
