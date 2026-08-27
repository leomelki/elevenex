import { buildSpawnCommand, findBinary } from '../config/system-paths.js';

/**
 * Resolves the `agy` executable (Google's Antigravity CLI).
 *
 * Like Gemini CLI, Antigravity ships no bundled native binary Elevenex could
 * vendor: it is installed by the user to `~/.local/bin` (macOS/Linux) or
 * `%LOCALAPPDATA%\Antigravity` (Windows). `findBinary` honours PATHEXT so it
 * picks the Windows shim rather than the extensionless POSIX shim that
 * CreateProcess cannot execute.
 */
export function resolveAntigravityBinary(): string {
  const override = process.env.ELEVENEX_ANTIGRAVITY_BIN?.trim();
  if (override) return override;
  return findBinary('agy') ?? 'agy';
}

/** Spawn descriptor for the resolved binary, with Windows shim handling. */
export function buildAntigravitySpawnCommand(): {
  command: string;
  shell: boolean;
} {
  return buildSpawnCommand(resolveAntigravityBinary());
}
