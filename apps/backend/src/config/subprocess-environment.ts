// Reserve room for argv and runtime-added variables with a conservative exec
// budget; host limits vary by OS and stack size. Never truncate credentials or
// silently remove a caller's configuration to make a process start.
const MAX_ENVIRONMENT_BYTES = 128 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;

export function assertSubprocessEnvironment(env: NodeJS.ProcessEnv): void {
  const entries = Object.entries(env).flatMap(([key, value]) =>
    value === undefined
      ? []
      : [{ key, bytes: Buffer.byteLength(key) + Buffer.byteLength(value) + 2 }],
  );
  // Include pointer-table overhead as well as the KEY=value\0 strings.
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes + 8, 8);
  if (
    bytes <= MAX_ENVIRONMENT_BYTES &&
    entries.every((entry) => entry.bytes <= MAX_ENTRY_BYTES)
  )
    return;
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
    `Subprocess environment exceeds the launch budget: keys=${entries.length} bytes=${bytes} limit=${MAX_ENVIRONMENT_BYTES} entryLimit=${MAX_ENTRY_BYTES} largestBytes=[${largest}]`,
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
