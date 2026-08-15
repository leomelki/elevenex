import { buildSpawnCommand, findBinary } from '../config/system-paths.js';

/**
 * ACP entrypoint for the Gemini CLI.
 *
 * `--experimental-acp` is still accepted by gemini-cli but is deprecated in
 * favour of `--acp` (verified against gemini-cli 0.55.1). Keeping the flag in a
 * single constant means a future rename is a one-line change rather than a
 * search across the runtime.
 */
export const GEMINI_ACP_FLAG = '--acp';

/**
 * Gemini refuses to load project-level agents, hooks and extensions in a folder
 * it does not consider trusted, and in ACP mode there is no TUI to answer the
 * trust prompt — it just logs "Skipping project agents due to untrusted folder"
 * to stderr and runs degraded. Elevenex only ever points Gemini at a worktree
 * the user explicitly opened, so the trust decision has already been made one
 * level up.
 */
export const GEMINI_TRUST_FLAG = '--skip-trust';

/**
 * Resolves the `gemini` executable.
 *
 * Unlike Codex, Gemini CLI ships no per-platform native binary, so there is
 * nothing bundled to look up: it is a plain Node package installed globally by
 * the user (npm, volta, fnm, …). `findBinary` honours PATHEXT so it picks the
 * Windows `gemini.cmd` shim rather than the extensionless POSIX shim that
 * CreateProcess cannot execute.
 */
export function resolveGeminiBinary(): string {
  const override = process.env.ELEVENEX_GEMINI_BIN?.trim();
  if (override) return override;
  return findBinary('gemini') ?? 'gemini';
}

/** Spawn descriptor for the resolved binary, with Windows shim handling. */
export function buildGeminiSpawnCommand(): {
  command: string;
  shell: boolean;
} {
  return buildSpawnCommand(resolveGeminiBinary());
}
