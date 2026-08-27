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
