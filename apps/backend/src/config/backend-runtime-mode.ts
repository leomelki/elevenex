export const ELEVENEX_BACKEND_MODE_ENV = 'ELEVENEX_BACKEND_MODE';

export type BackendRuntimeMode = 'local' | 'remote';

/**
 * Remote runtimes opt in explicitly from their generated launcher. Defaulting
 * to local keeps source checkouts and manually started backends independent of
 * host tooling such as tmux.
 */
export function getBackendRuntimeMode(
  env: NodeJS.ProcessEnv = process.env,
): BackendRuntimeMode {
  return env[ELEVENEX_BACKEND_MODE_ENV]?.trim().toLowerCase() === 'remote'
    ? 'remote'
    : 'local';
}

/**
 * tmux provides process persistence for POSIX remote runtimes. Local backends
 * deliberately own their child PTYs directly, and Windows remote runtimes use
 * their native process supervisor instead of a tmux-compatible shim.
 */
export function shouldUseTmux(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return getBackendRuntimeMode(env) === 'remote' && platform !== 'win32';
}
