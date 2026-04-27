import { accessSync, constants } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

// When the packaged Electron app is launched from Finder/DMG, macOS hands it
// a stripped PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) because no shell rc files
// are sourced. User-installed CLIs (tmux from Homebrew, claude/plannotator
// from ~/.local/bin) are then unreachable. These directories cover the common
// install locations and are prepended/appended wherever we spawn child
// processes or resolve external binaries.
export const COMMON_BINARY_PATHS: readonly string[] = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.local', 'bin'),
  '/usr/bin',
  '/bin',
];

export function findBinary(name: string): string | null {
  for (const dir of COMMON_BINARY_PATHS) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try next
    }
  }

  try {
    const found = execSync(`command -v ${name}`, {
      encoding: 'utf-8',
      env: { ...process.env, PATH: buildAugmentedPath() },
    }).trim();
    return found || null;
  } catch {
    return null;
  }
}

export function buildAugmentedPath(basePath: string = process.env.PATH || ''): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  const addPart = (part: string) => {
    if (part && !seen.has(part)) {
      seen.add(part);
      parts.push(part);
    }
  };

  for (const part of basePath.split(':')) {
    addPart(part);
  }
  for (const part of COMMON_BINARY_PATHS) {
    addPart(part);
  }

  return parts.join(':');
}

// macOS Electron apps launched from Finder/DMG inherit no shell env, so
// LANG / LC_* are unset. Claude Code and other CLIs then fall back to the
// POSIX (ASCII) locale and render multibyte UTF-8 glyphs as `_` or `?`.
// Ensure a UTF-8 locale is always present.
function ensureUtf8Locale(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isUtf8 = (value: string | undefined) =>
    typeof value === 'string' && /utf-?8/i.test(value);

  if (isUtf8(env.LC_ALL) || isUtf8(env.LANG) || isUtf8(env.LC_CTYPE)) {
    return env;
  }

  const fallback = 'en_US.UTF-8';
  return {
    ...env,
    LANG: env.LANG || fallback,
    LC_CTYPE: env.LC_CTYPE || fallback,
  };
}

export function buildAugmentedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return ensureUtf8Locale({
    ...base,
    PATH: buildAugmentedPath(base.PATH || ''),
  });
}
