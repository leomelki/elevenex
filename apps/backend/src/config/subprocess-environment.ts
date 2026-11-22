import { statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { getBackendRuntimeMode } from './backend-runtime-mode.js';

// Reserve room for argv and runtime-added variables with a conservative exec
// budget; host limits vary by OS and stack size. Never truncate credentials or
// silently remove a caller's configuration to make a process start.
const MAX_ENVIRONMENT_BYTES = 128 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;

export function assertSubprocessEnvironment(env: NodeJS.ProcessEnv): void {
  const values = Object.entries(env);
  let bytes = 8;
  let count = 0;
  let oversizedEntry = false;
  // The normal path needs no per-variable objects or sorting allocations.
  for (const [key, value] of values) {
    if (value === undefined) continue;
    const size = Buffer.byteLength(key) + Buffer.byteLength(value) + 2;
    bytes += size + 8;
    count++;
    oversizedEntry ||= size > MAX_ENTRY_BYTES;
  }
  if (bytes <= MAX_ENVIRONMENT_BYTES && !oversizedEntry) return;
  const entries = values.flatMap(([key, value]) =>
    value === undefined
      ? []
      : [{ key, bytes: Buffer.byteLength(key) + Buffer.byteLength(value) + 2 }],
  );
  const largest = entries
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)
    .map(
      (entry) =>
        `${entry.key.replace(/[^A-Za-z0-9_]/g, '?').slice(0, 80)}:${entry.bytes}`,
    )
    .join(',');
  // Names and byte counts only: values can contain tokens, prompts and URLs.
  throw new Error(
    `Subprocess environment exceeds the launch budget: keys=${count} bytes=${bytes} limit=${MAX_ENVIRONMENT_BYTES} entryLimit=${MAX_ENTRY_BYTES} largestBytes=[${largest}]`,
  );
}

/** Tracks only our shell projection, preserving changes made by other owners. */
export class ShellEnvironmentProjection {
  private readonly values = new Map<
    string,
    { readonly inherited: string | undefined; readonly projected: string }
  >();

  baseline(current: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const baseline = { ...current };
    for (const [key, value] of this.values) {
      if (baseline[key] !== value.projected) continue;
      if (value.inherited === undefined) delete baseline[key];
      else baseline[key] = value.inherited;
    }
    return baseline;
  }

  /** Compose into a fresh child env without allocating an intermediate baseline. */
  compose(
    shell: NodeJS.ProcessEnv,
    current: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv {
    const target = { ...shell, ...current };
    for (const [key, owned] of this.values) {
      if (current[key] !== owned.projected) continue;
      if (owned.inherited !== undefined) target[key] = owned.inherited;
      else if (Object.hasOwn(shell, key)) target[key] = shell[key];
      else delete target[key];
    }
    return target;
  }

  apply(
    target: NodeJS.ProcessEnv,
    baseline: NodeJS.ProcessEnv,
    next: NodeJS.ProcessEnv,
  ): void {
    // Validate before touching the target, retaining the last good environment
    // if a capture cannot safely be inherited by subprocesses.
    assertSubprocessEnvironment(next);
    for (const [key, value] of this.values) {
      if (target[key] !== value.projected) continue;
      if (value.inherited === undefined) delete target[key];
      else target[key] = value.inherited;
    }
    this.values.clear();
    for (const [key, projected] of Object.entries(next)) {
      if (projected === undefined || projected === baseline[key]) continue;
      this.values.set(key, { inherited: baseline[key], projected });
      target[key] = projected;
    }
  }
}

/** A remote launcher proxy is a fallback; the account's shell may select its own agent. */
export function shellConfiguredSshAgentSocket(
  base: NodeJS.ProcessEnv,
  shell: NodeJS.ProcessEnv,
): string | undefined {
  const dataRoot = base.ELEVENEX_DATA_ROOT;
  // Recognize only the desktop daemon's stable socket. Explicit launch-time
  // agent choices and local/legacy runtimes retain their existing precedence.
  if (
    getBackendRuntimeMode(base) !== 'remote' ||
    !dataRoot ||
    !isAbsolute(dataRoot) ||
    base.SSH_AUTH_SOCK !== join(dirname(dataRoot), 'agent.sock')
  )
    return undefined;
  const selected = shell.SSH_AUTH_SOCK;
  // An empty value is a deliberate opt-out and needs no socket.
  if (!selected) return selected;
  // Shells often export a stable symlink (for example ~/.ssh/ssh_auth_sock)
  // that a watcher retargets to the newest forwarded agent and removes while
  // no SSH session is attached. The shell capture is cached, so check the
  // socket at use time; otherwise signing, fetches and pushes fail although
  // the desktop proxy is connected. This is one local stat in remote proxy
  // mode only: no agent connection, key listing or copying. It is synchronous
  // because environment construction is synchronous for every spawn site.
  return statSync(selected, { throwIfNoEntry: false })?.isSocket()
    ? selected
    : undefined;
}
