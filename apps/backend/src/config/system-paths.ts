import { accessSync, constants } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import { Logger } from '@nestjs/common';
import simpleGit, { SimpleGit } from 'simple-git';

const logger = new Logger('SystemPaths');

// When the packaged Electron app is launched from Finder/DMG, macOS hands it
// a stripped PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) because no shell rc files
// are sourced. User-installed CLIs (tmux from Homebrew, claude/plannotator
// from ~/.local/bin) are then unreachable. These directories cover the common
// install locations and are prepended/appended wherever we spawn child
// processes or resolve external binaries.
export const COMMON_BINARY_PATHS: readonly string[] = (() => {
  const paths: string[] = [];
  if (process.platform === 'darwin') paths.push('/opt/homebrew/bin');
  paths.push(
    '/usr/local/bin',
    join(homedir(), '.local', 'bin'),
    '/usr/bin',
    '/bin',
  );
  return paths;
})();

// Marker emitted just before `env` output so we can robustly skip any noise
// rc files print at startup (compinit warnings, "Last login: …", banners,
// version-check notices, …). Using \0 since it cannot appear in env values.
const ENV_BOUNDARY = '>>>ELEVENEX_ENV_BOUNDARY<<<';

const REFRESH_THROTTLE_MS = 60_000;
const SHELL_TIMEOUT_MS = 5_000;

// Cached login-shell env. Populated on first call to `loadLoginShellEnv()`
// or via `refreshLoginShellEnv()`. Mutated through the helpers below; not
// exported directly so all access goes through `getCachedShellEnv()`.
let _shellEnvCache: NodeJS.ProcessEnv | null = null;
let _lastRefreshAt = 0;
let _refreshInFlight: Promise<void> | null = null;

// Per-cwd login-shell env cache. Some users wire version managers (nvm/fnm/
// rbenv/…) into their rc files via `chpwd` hooks that read `.nvmrc`/`.tool-
// versions` from the shell's startup directory. The global cache above is
// captured with no cwd so it picks up whatever default version the shell
// resolves at the user's $HOME — which is wrong for repos that pin a
// different version. We therefore keep a per-cwd cache, populated on demand
// when a spawn site provides a `cwd`. LRU-bounded so a backend tracking
// hundreds of worktrees doesn't grow unbounded.
const PER_CWD_CACHE_MAX = 64;
type CwdEnvEntry = {
  env: NodeJS.ProcessEnv;
  lastRefreshAt: number;
  lastRefreshAttemptAt: number;
};
const _cwdEnvCache = new Map<string, CwdEnvEntry>();
const _cwdRefreshInFlight = new Map<string, Promise<void>>();

function getMinimalBootPath(): string {
  const parts = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin'];
  if (process.platform === 'darwin') parts.push('/opt/homebrew/bin');
  return parts.join(':');
}

// Vars that describe the shell's own runtime state — they should not leak
// from a previous shell session into a fresh one. zsh recomputes them from
// the spawn `cwd` and shell lineage. Forwarding stale values would shadow
// what the new shell wants to set.
const PER_SHELL_INSTANCE_KEYS = new Set([
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
]);

// Baseline env to spawn a login shell with.
//
// - Global load (no cwd): minimal boot path so the captured env is "pure" rc-
//   file output, untainted by whatever `process.env` the backend inherited
//   (systemd, launchd, Finder/DMG, …).
// - Per-cwd load: inherit the global cache's env so the worktree-local shell
//   starts from the same baseline as the user's interactive session. This is
//   what makes the system general: anything an rc file sets up — version
//   managers (nvm, fnm, pyenv, rbenv, asdf, mise, volta), direnv hooks,
//   project exports, locale, custom env — flows into per-cwd loads, and the
//   worktree's chpwd hooks layer cwd-specific overrides on top.
function getShellBaselineEnv(forCwdLoad: boolean): NodeJS.ProcessEnv {
  if (!forCwdLoad || !_shellEnvCache) {
    return { PATH: getMinimalBootPath(), PS1: '' };
  }
  const baseline: NodeJS.ProcessEnv = { PS1: '' };
  for (const [key, value] of Object.entries(_shellEnvCache)) {
    if (PER_SHELL_INSTANCE_KEYS.has(key)) continue;
    if (typeof value === 'string') baseline[key] = value;
  }
  if (typeof baseline.PATH !== 'string') {
    baseline.PATH = getMinimalBootPath();
  }
  return baseline;
}

function getUserShell(): string {
  // Prefer SHELL (set by login). Fallback to /bin/sh, which exists on every
  // POSIX system — zsh isn't installed on most Linux servers.
  return process.env.SHELL || '/bin/sh';
}

function parseEnvOutput(raw: string): NodeJS.ProcessEnv {
  // Strip anything before our sentinel so chatty rc files (echo, banners,
  // compinit warnings) can't corrupt parsing. If the sentinel is missing
  // (older shells, sentinel got stripped), fall back to parsing the whole
  // output — the heuristic below still rejects non-`KEY=VALUE` lines.
  const idx = raw.indexOf(ENV_BOUNDARY);
  const envText = idx === -1 ? raw : raw.slice(idx + ENV_BOUNDARY.length);

  const parsed: NodeJS.ProcessEnv = {};
  for (const line of envText.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    // Reject keys that aren't valid shell identifiers — guards against
    // multi-line values (continuation lines) being parsed as new entries.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    parsed[key] = line.slice(eq + 1);
  }
  return parsed;
}

// Tag to prefix all log lines for this scope so they're greppable in tail
// output (`grep system-paths` filters everything related to env capture).
const cwdTag = (cwd?: string) => (cwd ? `cwd=${cwd}` : 'cwd=<global>');

// Single async helper used by both initial warm-up and runtime refresh.
// Returns null if the shell failed to produce any usable env. When `cwd` is
// provided, the shell starts in that directory so chpwd-style hooks (nvm,
// fnm, direnv) resolve the project-local version.
function runLoginShell(cwd?: string): Promise<NodeJS.ProcessEnv | null> {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const shell = getUserShell();
    const startedAt = Date.now();
    logger.debug(
      `async shell-env load starting (${cwdTag(cwd)} shell=${shell})`,
    );
    // `-i -l` sources both login files (.zprofile / .profile) AND interactive
    // rc files (.zshrc / .bashrc). Tools like nvm, fnm, rbenv, pyenv typically
    // inject PATH from the rc file, so login-only would miss them.
    const child = spawn(
      shell,
      ['-i', '-l', '-c', `printf '%s' '${ENV_BOUNDARY}'; env`],
      {
        env: getShellBaselineEnv(cwd !== undefined),
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd,
      },
    );
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, SHELL_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      raw += d.toString('utf8');
    });
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsed = Date.now() - startedAt;
      if (err) {
        logger.warn(
          `async shell-env load failed (${cwdTag(cwd)} elapsed=${elapsed}ms): ${err.message}`,
        );
        resolve(null);
        return;
      }
      const parsed = parseEnvOutput(raw);
      if (Object.keys(parsed).length === 0) {
        logger.warn(
          `async shell-env load produced no variables (${cwdTag(cwd)} shell=${shell} elapsed=${elapsed}ms)`,
        );
        resolve(null);
        return;
      }
      logger.log(
        `async shell-env loaded (${cwdTag(cwd)} keys=${Object.keys(parsed).length} elapsed=${elapsed}ms)`,
      );
      resolve(parsed);
    };
    child.on('close', () => finish());
    child.on('error', (err) => finish(err));
  });
}

function getCachedShellEnv(): NodeJS.ProcessEnv {
  return _shellEnvCache ?? {};
}

// Project the augmented shell-env baseline onto `process.env` itself so that
// any child process spawned with default env (simple-git, libraries that
// don't accept an env override, ad-hoc execSync calls, etc.) inherits the
// correct PATH and locale. Without this, every spawn site would have to
// remember to pass `buildAugmentedEnv()` — auditing all of them is a losing
// battle. Mutating process.env is normal Node practice and what every shell
// integration ultimately does.
//
// Rules:
//   - PATH is always recomputed (combined merge) so a user dotfile edit
//     observed via refresh is reflected for subsequent spawns.
//   - Other keys are added only if missing — we never clobber a value the
//     app deliberately set (e.g. `process.env.GIT_OPTIONAL_LOCKS = '0'` in
//     main.ts) or that the user passed via systemd/launchd/CLI.
function applyShellEnvToProcess(): void {
  const shellEnv = _shellEnvCache;
  if (!shellEnv) return;

  process.env.PATH = buildAugmentedPath(
    process.env.PATH || '',
    shellEnv.PATH || '',
  );

  for (const [key, value] of Object.entries(shellEnv)) {
    if (key === 'PATH' || value === undefined) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  const isUtf8 = (v: string | undefined) =>
    typeof v === 'string' && /utf-?8/i.test(v);
  if (
    !isUtf8(process.env.LC_ALL) &&
    !isUtf8(process.env.LANG) &&
    !isUtf8(process.env.LC_CTYPE)
  ) {
    process.env.LANG = process.env.LANG || 'en_US.UTF-8';
    process.env.LC_CTYPE = process.env.LC_CTYPE || 'en_US.UTF-8';
  }
}

// Synchronous shell-env load. Used both for the global cache warm-up and for
// per-cwd cold misses where we need the right env before the first spawn.
// `cwd` is optional; when provided, the shell starts in that directory.
//
// This blocks the event loop for the duration of the shell startup (~100ms-
// 500ms typically, capped at SHELL_TIMEOUT_MS), so the timing log is the
// primary lever for spotting users whose rc files have grown slow.
function loadLoginShellEnvSync(cwd?: string): NodeJS.ProcessEnv {
  const shell = getUserShell();
  const startedAt = Date.now();
  logger.debug(`sync shell-env load starting (${cwdTag(cwd)} shell=${shell})`);
  try {
    const raw = execSync(
      `${shell} -i -l -c "printf '%s' '${ENV_BOUNDARY}'; env" < /dev/null`,
      {
        encoding: 'utf-8',
        timeout: SHELL_TIMEOUT_MS,
        env: getShellBaselineEnv(cwd !== undefined),
        cwd,
      },
    );
    const parsed = parseEnvOutput(raw);
    const elapsed = Date.now() - startedAt;
    logger.log(
      `sync shell-env loaded (${cwdTag(cwd)} keys=${Object.keys(parsed).length} elapsed=${elapsed}ms)`,
    );
    return parsed;
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    logger.warn(
      `sync shell-env load failed (${cwdTag(cwd)} elapsed=${elapsed}ms): ${(err as Error).message}`,
    );
    return {};
  }
}

// Synchronous warm-up for the global cache. Used when a caller needs the
// shell env before any async warm-up has completed (rare, but possible during
// NestJS bootstrap before `OnApplicationBootstrap` fires). Subsequent calls
// hit the cache.
function loadLoginShellEnv(): NodeJS.ProcessEnv {
  if (_shellEnvCache) return _shellEnvCache;

  _shellEnvCache = loadLoginShellEnvSync();
  _lastRefreshAt = Date.now();
  applyShellEnvToProcess();
  return _shellEnvCache;
}

// Mark a per-cwd entry as recently used and evict the oldest if we exceed the
// LRU bound. JavaScript `Map` preserves insertion order, so re-inserting a key
// promotes it to the most-recent slot. Entries with an in-flight refresh are
// skipped during eviction so that an evict-then-cold-miss can never spawn a
// second login shell for a cwd that already has one running.
function touchCwdLru(cwd: string, entry: CwdEnvEntry): void {
  if (_cwdEnvCache.has(cwd)) _cwdEnvCache.delete(cwd);
  _cwdEnvCache.set(cwd, entry);
  while (_cwdEnvCache.size > PER_CWD_CACHE_MAX) {
    let evictKey: string | undefined;
    for (const key of _cwdEnvCache.keys()) {
      if (!_cwdRefreshInFlight.has(key)) {
        evictKey = key;
        break;
      }
    }
    if (evictKey === undefined) break;
    _cwdEnvCache.delete(evictKey);
    logger.debug(
      `per-cwd LRU evicted ${cwdTag(evictKey)} (size=${_cwdEnvCache.size}/${PER_CWD_CACHE_MAX})`,
    );
  }
}

// Async refresh of a single per-cwd entry. De-duplicated so concurrent callers
// share one shell startup. Refreshes overwrite the cached entry on success;
// failures keep the existing entry untouched.
function refreshCwdEnvAsync(
  cwd: string,
  attemptedAt = Date.now(),
): Promise<void> {
  const inFlight = _cwdRefreshInFlight.get(cwd);
  if (inFlight) {
    logger.debug(`per-cwd refresh deduped (${cwdTag(cwd)})`);
    return inFlight;
  }

  const existing = _cwdEnvCache.get(cwd);
  if (existing) {
    touchCwdLru(cwd, { ...existing, lastRefreshAttemptAt: attemptedAt });
  }

  logger.debug(`per-cwd refresh kicked off (${cwdTag(cwd)})`);
  const promise = runLoginShell(cwd)
    .then((parsed) => {
      if (parsed) {
        const refreshedAt = Date.now();
        touchCwdLru(cwd, {
          env: parsed,
          lastRefreshAt: refreshedAt,
          lastRefreshAttemptAt: refreshedAt,
        });
      }
    })
    .finally(() => {
      _cwdRefreshInFlight.delete(cwd);
    });
  _cwdRefreshInFlight.set(cwd, promise);
  return promise;
}

// Returns the shell env for `cwd`, populating the cache on first miss. Cold
// miss is sync so the very first spawn in a worktree gets the right env (e.g.
// the Node version pinned by `.nvmrc` rather than the global default). Stale
// entries are returned immediately and a background refresh is kicked off so
// edits to dotfiles are eventually picked up without stalling the spawn.
function getCwdEnv(cwd: string): NodeJS.ProcessEnv {
  const existing = _cwdEnvCache.get(cwd);
  const now = Date.now();
  if (existing) {
    touchCwdLru(cwd, existing);
    const ageMs = now - existing.lastRefreshAt;
    if (ageMs > REFRESH_THROTTLE_MS) {
      const attemptAgeMs = now - existing.lastRefreshAttemptAt;
      if (_cwdRefreshInFlight.has(cwd)) {
        logger.debug(
          `per-cwd cache hit, stale (${cwdTag(cwd)} age=${ageMs}ms) — refresh already running`,
        );
      } else if (attemptAgeMs > REFRESH_THROTTLE_MS) {
        logger.debug(
          `per-cwd cache hit, stale (${cwdTag(cwd)} age=${ageMs}ms) — scheduling async refresh`,
        );
        void refreshCwdEnvAsync(cwd, now);
      } else {
        logger.debug(
          `per-cwd cache hit, stale (${cwdTag(cwd)} age=${ageMs}ms) — refresh throttled (attemptAge=${attemptAgeMs}ms)`,
        );
      }
    } else {
      logger.debug(`per-cwd cache hit (${cwdTag(cwd)} age=${ageMs}ms)`);
    }
    return existing.env;
  }
  logger.debug(`per-cwd cache miss (${cwdTag(cwd)}) — sync-loading`);
  const env = loadLoginShellEnvSync(cwd);
  const loadedAt = Date.now();
  logger.log(
    `per-cwd cache miss introduced wait (${cwdTag(cwd)} elapsed=${loadedAt - now}ms)`,
  );
  touchCwdLru(cwd, {
    env,
    lastRefreshAt: loadedAt,
    lastRefreshAttemptAt: loadedAt,
  });
  return env;
}

// Asynchronously re-run the login shell and update the cache. Throttled so
// rapid bursts of client connections don't trigger repeated expensive shell
// startups. Non-blocking: callers can fire-and-forget.
//
// `force=true` bypasses the throttle (used by service bootstrap).
export function refreshLoginShellEnv(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - _lastRefreshAt < REFRESH_THROTTLE_MS) {
    logger.debug(`global refresh throttled (age=${now - _lastRefreshAt}ms)`);
    return Promise.resolve();
  }
  if (_refreshInFlight) {
    logger.debug(`global refresh deduped`);
    return _refreshInFlight;
  }

  // Set the throttle timestamp BEFORE the refresh completes so concurrent
  // callers within the window skip immediately. A fast-failing refresh will
  // therefore lock out retries for ~30s — acceptable trade-off vs. thundering
  // herd if the shell is slow to start.
  _lastRefreshAt = now;

  logger.debug(`global refresh kicked off (force=${force})`);
  _refreshInFlight = runLoginShell().then((parsed) => {
    if (parsed) {
      _shellEnvCache = parsed;
      _lastRefreshAt = Date.now();
      applyShellEnvToProcess();
    }
    // On failure: keep the existing cache rather than wiping it.
    _refreshInFlight = null;
  });
  return _refreshInFlight;
}

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

export function buildAugmentedPath(
  basePath: string = process.env.PATH || '',
  ...extraPaths: string[]
): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  const addPart = (part: string) => {
    if (part && !seen.has(part)) {
      seen.add(part);
      parts.push(part);
    }
  };

  for (const source of [basePath, ...extraPaths]) {
    for (const part of source.split(':')) {
      addPart(part);
    }
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

// Convenience wrapper around `simpleGit(worktreePath)` that overrides the
// default `process.env` baseline with the per-cwd login-shell env. Use this
// everywhere we run git inside a worktree — git invokes hooks (husky,
// lint-staged, pre-commit) that often shell out to `node`, and process.env
// has been globally augmented with the user's *default* nvm/fnm version,
// not the one the worktree pins via `.nvmrc`. Without the override, hooks
// resolve to the wrong node and bail or behave inconsistently.
export function worktreeSimpleGit(worktreePath: string): SimpleGit {
  return simpleGit(worktreePath).env(
    buildAugmentedEnv(process.env, worktreePath),
  );
}

// POSIX-compliant single-quote shell escape. Wraps the value in single quotes
// and escapes any embedded single quote with the standard `'\''` sequence.
// Safe to inline inside another double-quoted shell context (sh leaves single
// quotes alone when they appear inside double quotes).
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Critical env vars that must reach the actual command spawned inside a tmux
// session. The tmux *server* captures its env at startup and shares it with
// every session it creates; new sessions inherit the server's stale env, not
// the env we pass to the tmux *client* via `execSync`. Inlining these as
// `KEY=value cmd` shell prefixes is the simplest way to override per-command.
//
// PATH covers binary resolution (the actual reported bug — wrong `node`).
// Locale vars keep multibyte UTF-8 rendering correct.
const TMUX_INLINE_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const;

// Build a `KEY1='val' KEY2='val' ...` prefix string suitable for inlining in
// the shell command passed to `tmux new-session`. Pass extra app-specific keys
// (PLANNOTATOR_*, ELEVENEX_*, …) via `extraKeys` so the caller doesn't have to
// concatenate by hand. Skips vars that are unset.
export function buildTmuxInlineEnvPrefix(
  env: NodeJS.ProcessEnv,
  extraKeys: readonly string[] = [],
): string {
  const parts: string[] = [];
  for (const key of [...TMUX_INLINE_ENV_KEYS, ...extraKeys]) {
    const value = env[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    parts.push(`${key}=${shSingleQuote(value)}`);
  }
  return parts.join(' ');
}

export function buildAugmentedEnv(
  base: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): NodeJS.ProcessEnv {
  const startedAt = Date.now();
  // Merge order: login-shell baseline → caller's env (higher priority) → augmented PATH.
  // This ensures user-defined exports (tokens, tool homes, custom vars) are present
  // even when the backend was started without a login shell (Electron / Finder launch).
  // When `cwd` is provided we use the per-cwd cache so version-manager hooks (nvm,
  // fnm, direnv, …) resolve the project-local version. Without a cwd we fall back
  // to the global cache, which may be empty during early bootstrap — in that case
  // we still augment PATH from process.env, just without rc-file additions.
  const shellEnv = cwd
    ? getCwdEnv(cwd)
    : _shellEnvCache
      ? getCachedShellEnv()
      : loadLoginShellEnv();
  const merged = { ...shellEnv, ...base };
  // PATH ordering matters because dedup keeps the first occurrence: whichever
  // version-manager bin appears first wins for `node`/`python`/etc lookups.
  //
  // - With a `cwd`: the per-cwd shell env was captured by running zsh inside
  //   that worktree, so its PATH already reflects `.nvmrc`/chpwd hooks. We
  //   put it FIRST so the project-local node beats anything `process.env.PATH`
  //   accumulated from earlier (global) loads — which often includes the
  //   wrong default version on top of the right one.
  //
  // - Without a `cwd`: keep the historical order (base first) so that values
  //   the host explicitly set via systemd/launchd/CLI continue to take
  //   precedence over the rc-file baseline.
  const combinedPath = cwd
    ? buildAugmentedPath(shellEnv.PATH || '', base.PATH || '')
    : buildAugmentedPath(base.PATH || '', shellEnv.PATH || '');
  const elapsed = Date.now() - startedAt;
  // Most calls hit cache and finish in <1ms — debug-level keeps noise low while
  // still surfacing the rare cold-miss that synchronously spawns a shell.
  if (elapsed >= 5) {
    logger.log(`buildAugmentedEnv (${cwdTag(cwd)} elapsed=${elapsed}ms)`);
  } else {
    logger.debug(`buildAugmentedEnv (${cwdTag(cwd)} elapsed=${elapsed}ms)`);
  }
  return ensureUtf8Locale({
    ...merged,
    PATH: combinedPath,
  });
}
