import { findBinary } from '../config/system-paths.js';

let cachedResolved: string | undefined;

/**
 * Resolves the codex binary to spawn (for app-server, login, --version,
 * model-catalog refresh, and one-shot generation). Users manage the CLI
 * independently so every Codex feature uses the same current installation.
 *
 * Memoized for the process lifetime.
 */
export function resolveCodexBinary(): string {
  if (cachedResolved !== undefined) return cachedResolved;
  const configuredPath = process.env.ELEVENEX_CODEX_BIN?.trim();
  cachedResolved = selectCodexBinary(
    findBinary('codex'),
    configuredPath
      ? (findBinary(configuredPath) ?? configuredPath)
      : undefined,
  );
  return cachedResolved;
}

export function selectCodexBinary(
  installedBinary: string | null,
  configuredBinary?: string,
): string {
  return configuredBinary || installedBinary || 'codex';
}
