import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { findBinary } from '../config/system-paths.js';

/**
 * Walks up the node_modules tree from this file looking for the SDK install
 * dir and returns its realpath. With pnpm the top-level entry is a symlink
 * into `.pnpm/`, where the SDK's transitive deps live as siblings; following
 * the symlink puts us where Node's resolver can see `@openai/codex`.
 */
export function findSdkRealDir(): string | null {
  let dir = path.dirname(__filename);
  while (true) {
    const candidate = path.join(dir, 'node_modules', '@openai', 'codex-sdk');
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let cachedResolved: string | undefined;
let cachedSdkOverride: string | null | undefined;

/**
 * Resolves the codex binary to spawn (for app-server, login, --version,
 * model-catalog refresh, etc.). Elevenex deliberately does not fall back to
 * the executable shipped as an optional dependency of `@openai/codex-sdk`:
 * users manage the CLI independently so model discovery and execution use the
 * same current installation.
 *
 * Memoized for the process lifetime.
 */
export function resolveCodexBinary(): string {
  if (cachedResolved !== undefined) return cachedResolved;
  cachedResolved = selectCodexBinary(findBinary('codex'));
  return cachedResolved;
}

export function selectCodexBinary(installedBinary: string | null): string {
  return installedBinary ?? 'codex';
}

/**
 * Resolves an executable that the Codex SDK can spawn directly.
 *
 * Unlike Elevenex's other Codex process clients, the SDK does not expose a
 * `shell` spawn option. Modern Node versions reject direct spawning of Windows
 * `.cmd`/`.bat` npm shims with EINVAL, so passing the user-installed shim as
 * `codexPathOverride` breaks one-shot text generation. In that case, omit the
 * override and let the SDK use the native executable shipped with its own
 * platform package. Real Windows executables and POSIX launchers remain
 * eligible as overrides.
 */
export function resolveCodexSdkBinaryOverride(): string | undefined {
  if (cachedSdkOverride !== undefined) {
    return cachedSdkOverride ?? undefined;
  }

  cachedSdkOverride = selectCodexSdkBinaryOverride(findBinary('codex')) ?? null;
  return cachedSdkOverride ?? undefined;
}

export function selectCodexSdkBinaryOverride(
  installedBinary: string | null,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!installedBinary) return platform === 'win32' ? undefined : 'codex';
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(installedBinary)) {
    return undefined;
  }
  return installedBinary;
}
