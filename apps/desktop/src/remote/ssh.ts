import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RemoteHost } from '@elevenex/shared';
import { createAskpass, type Ask } from './askpass';
import { signalBackendTree } from '../backend/process-tree';
import { windowsAskpass } from './windows-askpass';
import { SshStderr, type SshAuthentication } from './ssh-authentication';

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
function includePath(value: string): string {
  const path = process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
  // Include expands variables, tokens and globs even inside quotes. Preserve
  // the exact file the user chose, including literal ${...}, %, [ and * names.
  const pattern = path.replace(/[\\*?[\]$]/g, char => char === '$' ? '[$]' : `\\${char}`);
  return `"${pattern.replaceAll('\\', '\\\\').replaceAll('%', '%%').replaceAll('"', '\\"')}"`;
}

/** OpenSSH owns configuration; these arguments only reserve the app's stdio session. */
export async function spawnSsh(host: RemoteHost, command: string, ask: Ask, interactive: boolean, signal: AbortSignal, helper: string,
  authentication?: (state: SshAuthentication) => void): Promise<{
  child: ChildProcessWithoutNullStreams; exited: Promise<void>; diagnostics(): string; stop(): Promise<void>;
}> {
  for (const file of [host.identityFile, host.configFile]) if (file) await access(file);
  const directory = await mkdtemp(join(tmpdir(), 'elevenex-ssh-'));
  let broker: Awaited<ReturnType<typeof createAskpass>> | undefined;
  try {
    await chmod(directory, 0o700);
    broker = await createAskpass(ask, interactive, signal);
    // Do not build a parallel SSH policy or parse/rewrite the user's settings.
    // With no -F, OpenSSH reads its native user and system configuration.
    // -v reports login progress, which separates a sign-in waiting after key
    // acceptance from a network stall. SshStderr removes that output.
    const args = ['-v', '-T', '-o', 'RemoteCommand=none', '-o', 'SessionType=default',
      '-o', 'StdinNull=no', '-o', 'ForkAfterAuthentication=no', '-o', 'ControlMaster=no'];
    // Reusing an existing ControlPath is safe. Publishing a shared master here
    // would let stopping this app's process kill other windows or terminal work.
    if (!interactive) args.push('-o', 'BatchMode=yes');
    if (host.configFile) {
      const config = join(directory, 'config');
      // ProxyJump embeds -F in a shell command without quoting its pathname on
      // some clients. A symlink preserves the selected file without depending
      // on how the client's Include directive expands percent tokens.
      if (process.platform === 'win32') {
        // Creating symlinks on Windows may require elevated privileges.
        await writeFile(config, `Include ${includePath(host.configFile)}\n`, { mode: 0o600 });
      } else {
        await symlink(resolve(host.configFile), config);
      }
      args.push('-F', config);
    }
    const wrapper = process.platform === 'win32' && interactive ? await windowsAskpass(directory, signal) : join(directory, 'askpass');
    if (process.platform !== 'win32') await writeFile(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`, { mode: 0o700 });
    signal.throwIfAborted();
    if (host.user) args.push('-l', host.user);
    if (host.port) args.push('-p', String(host.port));
    // -i stats its argument before token expansion. Supply the selected path
    // through one environment expansion instead: its value is copied literally,
    // so %, ${...}, spaces and quotes in real filenames are never reinterpreted.
    if (host.identityFile) args.push('-o', 'IdentityFile="${ELEVENEX_SSH_IDENTITY}"');
    args.push('--', host.host, command);
    const env: NodeJS.ProcessEnv = { ...process.env, ...broker.env, SSH_ASKPASS: wrapper, SSH_ASKPASS_REQUIRE: 'force' };
    if (host.identityFile) env['ELEVENEX_SSH_IDENTITY'] = host.identityFile;
    delete env['NODE_OPTIONS']; delete env['NODE_PATH']; delete env['ELECTRON_RUN_AS_NODE']; delete env['SSH_ASKPASS_PROMPT'];
    const child = spawn('ssh', args, { cwd: homedir(), env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostics = '';
    const record = (text: string) => { if (text) diagnostics = (diagnostics + text).slice(-16384); };
    const stderr = new SshStderr(authentication);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => record(stderr.write(text)));
    child.stderr.once('end', () => record(stderr.end()));
    child.on('error', error => record(error.message));
    const processExited = new Promise<void>(resolve => { child.once('error', () => resolve()); child.once('exit', () => resolve()); });
    const exited = new Promise<void>(resolve => { child.once('close', () => resolve()); });
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      signal.removeEventListener('abort', aborted);
      // The process group can still contain a ProxyCommand/askpass child after
      // ssh itself exits. It is ours even when the group leader is already gone.
      if (child.pid) {
        await signalBackendTree(child.pid, false).catch(() => { child.kill('SIGTERM'); });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]); }
        finally { if (timer) clearTimeout(timer); }
        await signalBackendTree(child.pid, true).catch(() => { child.kill('SIGKILL'); });
      }
      await processExited;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      await exited;
      await broker?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    })();
    const aborted = () => { void stop(); };
    signal.addEventListener('abort', aborted, { once: true });
    void processExited.then(stop).catch(() => undefined);
    if (signal.aborted) await stop();
    return { child, exited, diagnostics: () => diagnostics, stop };
  } catch (error) {
    await broker?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
