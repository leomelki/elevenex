import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteHost } from '@elevenex/shared';
import { createAskpass, type Ask } from './askpass';
import { signalBackendTree } from '../backend/process-tree';
import { windowsAskpass } from './windows-askpass';

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const configQuote = (value: string): string => `"${value.replaceAll('\\', '/').replaceAll('%', '%%').replaceAll('"', '\\"')}"`;

/** One fresh SSH process: user multiplexing cannot outlive our ownership or bypass consent. */
export async function spawnSsh(host: RemoteHost, command: string, ask: Ask, interactive: boolean, signal: AbortSignal, helper: string): Promise<{
  child: ChildProcessWithoutNullStreams; exited: Promise<void>; diagnostics(): string; stop(): Promise<void>;
}> {
  for (const file of [host.identityFile, host.configFile]) if (file) await access(file);
  const directory = await mkdtemp(join(tmpdir(), 'elevenex-ssh-'));
  let broker: Awaited<ReturnType<typeof createAskpass>> | undefined;
  try {
    await chmod(directory, 0o700);
    broker = await createAskpass(ask, interactive, signal);
    const config = join(directory, 'config');
    const defaultConfig = join(homedir(), '.ssh/config');
    const systemConfig = process.platform === 'win32' ? join(process.env['PROGRAMDATA'] ?? 'C:/ProgramData', 'ssh/ssh_config') : '/etc/ssh/ssh_config';
    // ProxyJump's nested ssh inherits -F, so the same trust and forwarding rules
    // apply at each hop. Include preserves Host/Match/Include and user proxies.
    await writeFile(config, [
      `Host ${host.forwardAgent ? `!${host.host} *` : '*'}`, '  ForwardAgent no',
      'Host *', '  StrictHostKeyChecking ask', '  VerifyHostKeyDNS no', '  UpdateHostKeys no',
      '  ForwardX11 no', '  ClearAllForwardings yes', '  PermitLocalCommand no',
      '  ControlMaster no', '  ControlPath none', '  ControlPersist no',
      '  RequestTTY no', '  RemoteCommand none', '  SessionType default', '  StdinNull no', '  ForkAfterAuthentication no',
      '  ConnectTimeout 15', '  ConnectionAttempts 1', '  ServerAliveInterval 10', '  ServerAliveCountMax 2',
      '  LogLevel ERROR', '  EscapeChar none',
      '  NumberOfPasswordPrompts 1', `  BatchMode ${interactive ? 'no' : 'yes'}`, 'Host *',
      `  Include ${configQuote(host.configFile ?? defaultConfig)}`,
      ...(host.configFile ? [] : ['Host *', `  Include ${configQuote(systemConfig)}`]),
      ...(host.forwardAgent ? [`Host ${host.host}`, '  ForwardAgent yes'] : []), '',
    ].join('\n'), { mode: 0o600 });
    const wrapper = process.platform === 'win32' && interactive ? await windowsAskpass(directory, signal) : join(directory, 'askpass');
    if (process.platform !== 'win32') await writeFile(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`, { mode: 0o700 });
    signal.throwIfAborted();
    const args = ['-T', '-F', config];
    if (host.user) args.push('-l', host.user);
    if (host.port) args.push('-p', String(host.port));
    if (host.identityFile) args.push('-i', host.identityFile.replaceAll('%', '%%'));
    args.push('--', host.host, command);
    const env: NodeJS.ProcessEnv = { ...process.env, ...broker.env, SSH_ASKPASS: wrapper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'elevenex:0', ELECTRON_RUN_AS_NODE: '1' };
    delete env['NODE_OPTIONS']; delete env['NODE_PATH'];
    const child = spawn('ssh', args, { cwd: homedir(), env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString('utf8')).slice(-16384); });
    child.on('error', error => { diagnostics = (diagnostics + error.message).slice(-16384); });
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
