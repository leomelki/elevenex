import { findBinary } from '../config/system-paths.js';
import { realpath, stat } from 'node:fs/promises';

/** Small async check; follows npm/native-install symlinks to the actual file. */
export async function codexBinaryIdentity(binary = resolveCodexBinary()): Promise<string | null> {
  try {
    const path = await realpath(binary);
    const file = await stat(path);
    return `${path}:${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
  } catch {
    // An unavailable identity must not cause an unnecessary server restart.
    return null;
  }
}

/**
 * Resolves the codex binary to spawn (for app-server, login, --version,
 * model-catalog refresh, and one-shot generation). Users manage the CLI
 * independently so every Codex feature uses the same current installation.
 *
 * Path lookup is cached by system-paths and invalidated on provider refresh.
 */
export function resolveCodexBinary(): string {
  const configuredPath = process.env.ELEVENEX_CODEX_BIN?.trim();
  return selectCodexBinary(
    findBinary('codex'),
    configuredPath
      ? (findBinary(configuredPath) ?? configuredPath)
      : undefined,
  );
}

export function selectCodexBinary(
  installedBinary: string | null,
  configuredBinary?: string,
): string {
  return configuredBinary || installedBinary || 'codex';
}
