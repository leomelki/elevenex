# Backend Git compatibility

The backend supports Git 2.25 and newer. Git runs on the backend host, including
remote hosts; the Git installed on the desktop does not determine remote
capabilities. Do not assume that a successful `rev-parse` exit means every option
was recognized: older Git can echo unknown options into stdout.

Repository discovery canonicalizes Git's absolute or working-directory-relative
paths in Node, preserves significant whitespace, and validates the output shape.
Symlink aliases share the same repository identity and concurrency budget.
New repository setup uses `init` and `symbolic-ref` so it does not depend on
`init --initial-branch` or the person's default branch setting. Repository root
paths containing line breaks are not supported by the line-based discovery and
worktree-list formats used with older Git.

Loose and packed refs retain the filesystem-based fast path and periodic Git
verification. Reftable repositories use Git to resolve HEAD, remote symrefs and
nested repository HEADs; their on-disk HEAD file is a placeholder. Its bounded
cache checks both shared and per-worktree `reftable/tables.list` versions, so
unchanged reads launch no Git processes within the verification window and ref
updates invalidate immediately. Periodic verification remains in place for
filesystems with coarse metadata, and errors never become permanently cached
missing refs. It never decodes Git's binary tables. Its 4 MiB metadata budget
does not reduce the existing review/status cache budgets. The local-ref cache
owns its cleanup.
SHA-256 object IDs are supported where
the installed Git supports that repository format. Tests probe Git's supported
formats and explicitly skip unsupported formats rather than changing Git's
configuration.

Every backend-owned Git process must use `isolateGitEnvironment` after building
its environment. Repository, writable object-store and pathspec variables
inherited from a parent hook, IDE or shell must not redirect work into another
repository. Inherited command-scope configuration retains its original ordering
and Git quoting, except `core.worktree` and command-scope includes that could
reintroduce it indirectly. Invalid command configuration fails without printing
potentially private values.

System, global, XDG, repository and per-worktree configuration files, including
their `include`/`includeIf` rules, continue to follow the installed Git version's
rules. PATH, SSH, credentials, proxies, signing, index format, fsmonitor,
untracked-cache and replacement-object policies remain available. Read-only
`GIT_ALTERNATE_OBJECT_DIRECTORIES` caches remain available too. Existing
operation-specific rules still apply, including lock-free background reads,
disabled lazy fetch for reads and ignoring dirty nested working trees.
Intentional operation-specific overrides, including temporary
`GIT_INDEX_FILE` values, are applied after isolation. This rule does not change
the environment of user-owned terminals or agent commands.

Run the portable regressions with:

```sh
pnpm --dir apps/backend run test:git
```

The Git compatibility workflow runs these regressions on Linux, macOS and
Windows, with Node 22/24, and builds isolated Git 2.25.1 and 2.56.0 binaries on
Linux. It does not replace system Git. The wider task, branch, worktree, file and
review integration suites remain available through the backend's regular Jest
command.

Compare compiled revisions with the existing performance tools:

```sh
node scripts/benchmark-backend-performance.cjs BEFORE_DIST AFTER_DIST artifacts/git-performance/backend
node --expose-gc scripts/benchmark-change-review.cjs AFTER_DIST artifacts/git-performance/review.json
```

These create disposable repositories and keep network calls simulated or
disabled. Set `ELEVENEX_BENCHMARK_SHELL` to a controlled login shell when a
version manager or shell profile would otherwise select a different Git during
the comparison. Use the same Git and harness for both revisions. Benchmark
outputs belong under ignored `artifacts/`, not in this guide.

Source installs need native addons built for the current OS, architecture and
Node ABI. Do not reuse `node_modules` copied from another machine or Node major.
After changing Node, use a compatible compiler and rebuild the installed
`node-pty` and `better-sqlite3` packages with pnpm. A TypeScript build alone does
not verify native addon loading or a packaged application's startup.
