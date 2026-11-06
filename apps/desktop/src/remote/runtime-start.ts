/** Remote startup and revision handoff; never signals a PID discovered on disk. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { queryDaemon, requestHandoff, type RuntimeHealth, type RuntimeLease } from './runtime-control';

interface RuntimeStartup {
  readonly root: string;
  readonly installation: string;
  readonly version: string;
  readonly port: number;
  readonly token: string;
  readonly lease: RuntimeLease;
  readonly runtime: string;
  /** Only an explicit connect/retry may interrupt another revision's work. */
  readonly allowUpdate: boolean;
}

export async function ensureDaemon(options: RuntimeStartup): Promise<RuntimeHealth> {
  const { root, installation, version, port, token, lease, runtime, allowUpdate } = options;
  let spawned = false;
  let starts = 0;
  let sawVacancy = false;
  let replacing: string | undefined;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const health = await queryDaemon(root, port, token, lease).catch(() => undefined);
    if (health) {
      if (health.replacement && health.replacement !== version) throw new Error('EX11_UPDATE: competing revision is replacing this daemon; retry explicitly after updating this desktop');
      if (health.version === version) {
        if (health.ready && !health.replacement) return health;
      } else if (replacing) {
        if (health.instance !== replacing) throw new Error('EX11_UPDATE: competing revision acquired the daemon; retry explicitly after updating this desktop');
        // The stop request may have lost its reply. Observe durable ownership;
        // never replay a destructive request or stop a different instance.
      } else if (health.replacement === version) {
        // Joining an accepted handoff is safe even during background recovery.
        replacing = health.instance;
      } else {
        if (!allowUpdate) throw new Error('EX11_UPDATE: explicit connection required to replace a different backend revision');
        if (sawVacancy) throw new Error('EX11_UPDATE: competing revision acquired the daemon during startup; retry explicitly');
        if (health.handoff !== 1) throw new Error('EX11_UPDATE: legacy daemon requires one manual stop before authenticated updates are available');
        replacing = health.instance;
        const reply = await requestHandoff(root, port, token, health, version).catch(() => undefined);
        if (reply && reply.instance === health.instance && reply.version === health.version && !reply.replacement) {
          throw new Error('EX11_UPDATE: handoff rejected; verify the prepared remote runtime and retry explicitly');
        }
        if (reply && (reply.instance !== health.instance || reply.version !== health.version || reply.replacement !== version)) {
          throw new Error('EX11_UPDATE: competing revision already requested a different handoff; retry explicitly');
        }
      }
    } else {
      sawVacancy = true;
      // Accepted handoffs belong to the old daemon, which transfers its lock
      // directly. Even a lost reply must not create a competing launcher.
      if (replacing) { await delay(250); continue; }
      if (starts >= 16) throw new Error('EX11_CONFIGURATION: the remote daemon cannot acquire its ownership port or prepare its private sockets');
      // A stale TCP address may belong to another service. Only the kernel UDP
      // reservation authorizes startup, including after an unconfirmed stop.
      if (!spawned) {
        spawned = true; starts++;
        const child = spawn(process.execPath, [runtime, 'daemon', root, installation, version], { cwd: root, detached: true, stdio: 'ignore', env: process.env });
        child.once('error', () => { spawned = false; }); child.once('exit', () => { spawned = false; }); child.unref();
      }
    }
    await delay(health ? 100 : 250);
  }
  if (replacing) throw new Error('EX11_UPDATE: handoff timed out; check the remote daemon and retry explicitly');
  throw new Error('EX11_RUNTIME: backend did not become ready; check bundled Node compatibility and backend prerequisites');
}
