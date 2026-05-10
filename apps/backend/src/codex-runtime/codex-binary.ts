import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { findBinary } from '../config/system-paths.js';

/**
 * Maps Node's process.{platform,arch} to the target triple that the
 * `@openai/codex` npm package uses to publish platform-specific binaries.
 * Mirrors the logic in `@openai/codex-sdk` so we end up at the exact same
 * binary the SDK would have spawned via `codex exec`.
 */
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

function targetTriple(): string | null {
  const { platform, arch } = process;
  if (platform === 'linux' || platform === 'android') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl';
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
    return null;
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'x86_64-apple-darwin';
    if (arch === 'arm64') return 'aarch64-apple-darwin';
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
    return null;
  }
  return null;
}

/**
 * Resolves the codex binary that ships alongside `@openai/codex-sdk` (via
 * its `@openai/codex` dependency and the platform-specific optionalDependency
 * package, e.g. `@openai/codex-linux-x64`). This is the exact binary the SDK
 * would have spawned via `codex exec` — same version, same vendored path.
 *
 * Returns `null` when:
 *   - the host platform isn't supported by codex,
 *   - the @openai/codex package isn't installed (dev mode without deps),
 *   - the platform-specific optional dep failed to install (mismatched os/cpu).
 *
 * The caller is expected to fall back to a PATH lookup in that case.
 */
/**
 * Walks up the node_modules tree from this file looking for the SDK install
 * dir and returns its realpath (so we end up inside `.pnpm/` when pnpm is
 * involved, where the SDK's transitive deps are siblings).
 */
function findSdkRealDir(): string | null {
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

export function findBundledCodexPath(): string | null {
  const triple = targetTriple();
  if (!triple) return null;
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[triple];
  if (!platformPackage) return null;
  // We can't directly `require.resolve('@openai/codex/package.json')` from
  // our own __filename because:
  //   1. pnpm doesn't hoist transitive deps into the top-level node_modules,
  //      so `@openai/codex` isn't visible there — only `@openai/codex-sdk`
  //      is — and
  //   2. modern Node refuses `require.resolve('<pkg>/package.json')` when
  //      the package has an `exports` map that doesn't list `./package.json`
  //      (which `@openai/codex-sdk` doesn't).
  // Workaround: find the SDK install dir on disk, follow the pnpm symlink
  // to its realpath, then anchor a `createRequire` there — from inside the
  // SDK's own pnpm dir, the transitive `@openai/codex` resolves normally.
  const sdkDir = findSdkRealDir();
  if (!sdkDir) return null;
  try {
    // The anchor file doesn't need to exist; createRequire just uses its
    // directory as the lookup base.
    const sdkRequire = createRequire(path.join(sdkDir, '__elevenex_anchor.js'));
    const codexPackageJsonPath = sdkRequire.resolve(
      '@openai/codex/package.json',
    );
    const codexRequire = createRequire(codexPackageJsonPath);
    const platformPackageJsonPath = codexRequire.resolve(
      `${platformPackage}/package.json`,
    );
    const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const binPath = path.join(
      path.dirname(platformPackageJsonPath),
      'vendor',
      triple,
      'codex',
      binaryName,
    );
    return existsSync(binPath) ? binPath : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the codex binary to spawn for app-server / one-off CLI calls.
 * Prefers the binary bundled alongside `@openai/codex-sdk` so we use the
 * exact version this build was tested against; falls back to whatever
 * `codex` is on the user's PATH (Homebrew, npm global install, etc.) when
 * the bundled binary can't be located.
 */
export function resolveCodexBinary(): string {
  return findBundledCodexPath() ?? findBinary('codex') ?? 'codex';
}
