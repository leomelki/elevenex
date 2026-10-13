import { spawn } from 'node:child_process';
import { buildSpawnCommand, findBinary } from '../config/system-paths.js';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function resolveOpenCodeBinary(): Promise<string> {
  const binary = process.env.OPENCODE_BINARY?.trim() || findBinary('opencode');
  if (binary) return binary;
  const candidate = join(homedir(), '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  try { await access(candidate); return candidate; } catch { return 'opencode'; }
}

const versions = new Map<string, Promise<number>>();
/** Once per CLI binary, asynchronously determine which official protocol to use. */
export function openCodeMajorVersion(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const cached = versions.get(binary);
  if (cached) return cached;
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
  versions.set(binary, result);
  void result.catch(() => {
    if (versions.get(binary) === result) versions.delete(binary);
  });
  return result;
}
