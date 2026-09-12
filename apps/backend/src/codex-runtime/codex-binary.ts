import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { findBinary } from '../config/system-paths.js';

const WINDOWS_CODEX_PACKAGES: Partial<Record<NodeJS.Architecture, string>> = {
  x64: '@openai/codex-win32-x64',
  arm64: '@openai/codex-win32-arm64',
};

const WINDOWS_CODEX_TARGETS: Partial<Record<NodeJS.Architecture, string>> = {
  x64: 'x86_64-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc',
};

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

  const installedBinary = findBinary('codex');
  const nativeWindowsBinary = installedBinary
    ? findNativeWindowsCodexBinary(installedBinary)
    : null;
  cachedSdkOverride =
    selectCodexSdkBinaryOverride(
      installedBinary,
      process.platform,
      nativeWindowsBinary,
    ) ?? null;
  return cachedSdkOverride ?? undefined;
}

export function selectCodexSdkBinaryOverride(
  installedBinary: string | null,
  platform: NodeJS.Platform = process.platform,
  nativeWindowsBinary: string | null = null,
): string | undefined {
  if (!installedBinary) return platform === 'win32' ? undefined : 'codex';
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(installedBinary)) {
    return nativeWindowsBinary ?? undefined;
  }
  return installedBinary;
}

/**
 * npm/pnpm expose Codex on Windows through a `.cmd` shim, but the SDK uses
 * `spawn()` without a shell and therefore needs the native executable. Resolve
 * the platform package from beside that shim so the SDK and the normal runtime
 * still use the exact same user-managed Codex installation.
 */
export function findNativeWindowsCodexBinary(
  installedBinary: string,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  if (!/\.(cmd|bat)$/i.test(installedBinary)) return null;

  const platformPackage = WINDOWS_CODEX_PACKAGES[arch];
  const target = WINDOWS_CODEX_TARGETS[arch];
  if (!platformPackage || !target) return null;

  try {
    const shimRequire = createRequire(
      path.join(path.dirname(installedBinary), '__elevenex_codex_anchor.js'),
    );
    const codexPackageJson = shimRequire.resolve('@openai/codex/package.json');
    const codexRequire = createRequire(codexPackageJson);
    const platformPackageJson = codexRequire.resolve(
      `${platformPackage}/package.json`,
    );
    const binaryPath = path.join(
      path.dirname(platformPackageJson),
      'vendor',
      target,
      'codex',
      'codex.exe',
    );
    return existsSync(binaryPath) ? binaryPath : null;
  } catch {
    return null;
  }
}
