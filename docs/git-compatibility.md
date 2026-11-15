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

Loose and packed refs retain the filesystem-based fast path. Reftable
repositories use Git to resolve HEAD, remote symrefs and nested repository HEADs;
their on-disk HEAD file is a placeholder. SHA-256 object IDs are supported where
the installed Git supports that repository format. Tests probe Git's supported
formats and explicitly skip unsupported formats rather than changing Git's
configuration.

Every backend-owned Git process must use `isolateGitEnvironment` after building
its environment. Repository, object-store, pathspec and command-line config
variables inherited from a parent hook, IDE or shell must not redirect work into
another repository. PATH, authentication and global configuration remain
available. Intentional operation-specific overrides, including temporary
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

Source installs need native addons built for the current OS, architecture and
Node ABI. Do not reuse `node_modules` copied from another machine or Node major.
After changing Node, use a compatible compiler and rebuild the installed
`node-pty` and `better-sqlite3` packages with pnpm. A TypeScript build alone does
not verify native addon loading or a packaged application's startup.
