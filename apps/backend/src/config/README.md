# Subprocess environments

`system-paths.ts` owns bounded global and per-worktree login-shell captures,
binary discovery and environment assembly. `ShellEnvService` warms the global
capture at startup; HTTP activity schedules throttled refreshes. Captures retain
the existing concurrency, output, deadline and process-group cleanup limits.

Global refreshes replace the previous shell-owned projection instead of merging
indefinitely into `process.env`. Launch-time settings and later application
overrides keep priority. Shell-added exports removed from a later capture are
removed from the projection; changed exports update. Failed captures retain the
last good cache and projection.

FNM's [shell initialization](https://github.com/Schniz/fnm/blob/master/src/commands/env.rs)
creates a unique `fnm_multishells/<id>/bin` directory per POSIX shell
(`fnm_multishells/<id>` on Windows). Exact PATH deduplication cannot prevent these
from accumulating. Environment assembly retains only the first FNM multishell
entry, preserving PATH priority and all ordinary tool directories. This also
repairs already inflated inherited paths. Worktree captures take priority over
the global PATH so project-specific Node versions still apply. No directories
or version-manager files are deleted.

`subprocess-environment.ts` tracks projection ownership and checks captures and
assembled child environments before use. The conservative budget is 128 KiB
including string terminators and pointer overhead, with at most 64 KiB per
entry, leaving room for command arguments and provider-added settings. This is
an environment budget, not a guarantee that arbitrary argument lists fit the
host's exec limit. Oversized captures/projections retain the last good state;
oversized caller overrides fail explicitly without truncating or dropping
credentials. Diagnostics include only counts, byte sizes and up to five bounded
variable names, never values. Normal Git/agent configuration and credentials
continue to flow through the existing environment builders.

Backend source edits require restarting `pnpm desktop:dev` to rebuild its engine.
A renderer refresh does not update backend code or an already running agent.

## Git versions and performance

Current, maintained Git releases are the primary target. Install a current,
security-patched Git on the machine running the backend, including SSH servers.
Elevenex uses that machine's Git and normal repository configuration; it does not
bundle a second Git or require administrator access to run. Worktree login-shell
environments can select a different Git, so capabilities follow the effective
PATH rather than a single global version assumption.

Git 2.25 is a **best-effort legacy target** for basic repository discovery,
initialization, worktree listing, and task lifecycle operations with ordinary
file-backed refs and paths. This is not a promise that every feature or newer
repository format works with Git 2.25. Versions below it are untested. Supporting
legacy Git must not reduce modern Git's correctness, capabilities, or throughput.
When a future capability has no small, safe fallback, explain which operation
needs an upgrade rather than implementing a second Git engine or silently
returning incomplete results.

### Command selection and caching

`git-capabilities.ts` coalesces version discovery by effective PATH, PATHEXT,
Git helper path, and cwd when PATH contains relative entries. Successful probes
are cached for five minutes in a bounded 64-entry LRU; failures are evicted.
PATH changes select a fresh entry, and an in-place upgrade is recognized after
expiry or a backend restart. Probes have a five-second subprocess deadline.
They run only for operations that choose different command forms, never for
routine status reads. Prefer a documented native capability; select a fallback
only for a known lack of support, not arbitrary command failures. Never retry
mutations automatically after an unknown outcome.

| Operation | Modern behavior | Legacy behavior |
| --- | --- | --- |
| Repository discovery | One `rev-parse` query, paths resolved against the physical cwd; concurrent cached discovery is shared | Same process count; avoids the unnecessary Git 2.31 `--path-format` requirement |
| New repository | `init --initial-branch=main` on Git 2.28+ | `init`, then `symbolic-ref` before the first commit |
| Worktree listing | `worktree list --porcelain -z` on Git 2.36+, preserving embedded newlines in paths and lock reasons | Line-delimited output for ordinary paths |
| Task status | One porcelain-v2 query returns branch, commit, dirty state and conflicts; skips unused ahead/behind traversal and rename detection | Same query works on Git 2.25; no version probe or three-command fallback |
| Default branch | One bounded candidate-ref query and one remote configuration query; no per-candidate process or branch subjects | Same command count and selection order |
| Ref snapshots | Loose/packed refs retain the existing filesystem cache; reftable uses native metadata queries and table-stack version invalidation | Existing file-backed ref reads |

Reftable's on-disk `HEAD` is a compatibility stub, not the real branch. Native
reads preserve branch names, detached/unborn HEAD, linked-worktree isolation and
remote ref updates. Snapshots coalesce concurrent requests and recheck changed
table lists, with a fixed 1.5-second verification deadline that cache hits do
not extend. Native remote ref results are shared only while in flight, so a
consumer retaining a snapshot still observes subsequent fetches. Worktree cache
release also clears its reftable snapshot. Never convert modern ref storage to
loose files merely to accommodate an older reader.

### Repository tuning

Git's own enabled commit graphs, multi-pack indexes, untracked caches, supported
filesystem monitors, index optimizations and checkout settings remain available.
Background reads disable optional index writes to avoid competing with agents;
idle, unassigned managed checkouts may persist index caches explicitly. Newly
created clean worktrees avoid an immediate redundant full status scan, and pool
allocation prefers a free checkout closest to the requested commit.

Do not force `checkout.workers`, `feature.manyFiles`, sparse checkout, partial
clone, ref formats or maintenance schedules globally. Parallel checkout can help
SSDs/NFS but hurt spinning disks or small machines; settings must respect the
filesystem, other Git clients and concurrent tasks. Maintenance and monitor
daemons have independent resource lifetimes and are not work for a UI poll.
The existing `benchmark-change-review.cjs --tune` option changes only disposable
fixtures. Use measured workloads before adopting automatic tuning.

References: [Git status performance](https://git-scm.com/docs/git-status#_untracked_files_and_performance),
[parallel checkout](https://git-scm.com/docs/git-config#Documentation/git-config.txt-checkoutworkers),
[reftable storage](https://git-scm.com/docs/reftable).

### Validation

`scripts/test-git-runtime.mjs` runs the focused backend regression slice with an
explicit Git executable. It uses a temporary shell/PATH so normal per-worktree
shell captures cannot silently replace the selected Git during the run. Fixtures
are disposable, global/system Git configuration is excluded, and no personal
repository or installed Git is changed. This POSIX runner covers local Git
operations, not HTTPS/SSH authentication or packaged desktop startup.

```sh
node scripts/test-git-runtime.mjs /usr/bin/git
node scripts/test-git-runtime.mjs /path/to/modern/git --modern
```

`--modern` requires a real Git with reftable support (Git 2.45+) and enables
native reftable and NUL-delimited worktree tests. The legacy run explicitly
skips these modern-only cases. The Git regression workflow runs both the
runner's maintained Git and a pinned legacy binary. Regression assertions cover
subprocess counts, in-flight sharing, branch/commit changes, index persistence,
conflicts, unusual paths and lifecycle recovery. Store per-run timing, trace
and test logs under ignored `artifacts/`; do not append validation histories here.

`node scripts/benchmark-task-git.cjs apps/backend/dist artifacts/task-git.json`
compares the previous and current status/default-branch command sequences on a
disposable 5,000-file, 602-branch, 401-commit fixture. It alternates ten samples per
implementation, checks equivalent results and unchanged Git configuration, and
reports median latency plus Trace2 subprocess counts. Compile the backend first;
timing depends on the host, filesystem and effective Git selected by its shell.
The fixture also measures 5,000 changed files. Porcelain v2 carries more data
than v1 for very dirty checkouts, so fewer subprocesses do not guarantee lower
latency in every case. Preserve the single-command branch/commit/status snapshot
and measure both clean and dirty workloads when changing this path.
