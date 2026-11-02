# Repository Changes owner

`RepositoryReviewComponent` owns a selected **task**, independently of the selected
session. It composes the existing DiffReview and keeps selected-reply review as
an explicitly separate fourth source. Reply patches retain their original
session/turn ownership and recorded-patch limitations. Opening a reply selects
that source; selecting a repository source never substitutes the reply patch.

On the first review of a task, choose Uncommitted when the backend's complete
uncommitted total is positive (including staged, unstaged and untracked entries).
Otherwise choose Last commit when HEAD exists; an unborn repository stays on
Uncommitted. Resolve this before showing the initial file list. Branch changes
remains an explicit choice. A bounded cache remembers manual source/base choices
for twenty tasks, including explicit empty-source choices. Explicit Refresh rechecks the automatic choice against the current workspace.
Background refresh and reconnection do not change a reader's source. Probe failures remain retryable,
and task/scope/manual-choice changes invalidate an in-flight default check.

Below 720px, sources use the compact dropdown. Wider reviews use the shared
Segmented control for one-click source switching. Both share the same controlled
source; resizing closes a hidden menu and returns keyboard focus to the visible
control. Selected reply joins the inline choices when a reply is available.

The default header has two rows: source/base with aggregate counts and details/
refresh actions, then file navigation with the Changes/Full files toggle
and wrap. Comparison SHAs, explanation and read-only status live in the retained
**Comparison details** dialog. Search, backend pagination and Viewed totals live
in the file picker, keeping those controls available without permanent header
rows. A filtered picker stays reopenable with zero results, and Clear filter
returns focus to its input. The search glyph indicates an active filter.

This deliberately reduces the former seven stacked bands; the 440px header is
70px tall (72px with inline source choices). The same state remains mounted
during shell-controlled wide takeover. Hidden reviews close the file picker. The existing
review still owns pinned headers, keyboard navigation and reading anchors.

Uncommitted shows separate Staged (HEAD → index), Unstaged (index → working file)
and Untracked entries. A path can appear twice: these are two comparisons, not a
net HEAD-to-worktree diff. Counts describe those layers. Mode changes and rename
origins are labelled. Unknown line counts on oversized untracked files show `?`
and totals are lower bounds, never a false exact zero. Unmerged index entries show explicit unavailable-source feedback; committed
sources remain available while conflicts are resolved. No staging, commits or
fetches occur in this feature; the task header owns those operations.

Last commit compares pinned HEAD to its first parent; root commits use an empty
tree in the repository’s SHA-1 or SHA-256 object format. Merge commits explain the first-parent choice. An unborn HEAD gives a
truthful empty state. Branch changes use the unique merge-base of the selected
target and pinned task HEAD, excluding the index/worktree. Defaults prefer the
task’s recorded creation base (excluding its own branch), repository preference,
then the existing git default-base discovery
(remote HEAD where available), with the task starting commit as a final fallback. A bounded 50-result branch search searches every
local/remote ref on the backend; refining the query reaches omitted branches.
A full commit ID is also accepted. Missing/deleted/unrelated/ambiguous bases
require another choice; no fallback silently changes the comparison.

A 100-entry metadata window and server-side path search reach every changed file.
DiffReview renders 12 cards and 400 lines at a time; the store permits three
concurrent file reads, matching task/scope/source/revision/file/mode. Content
windows replace each other with Previous/More controls. Context requests expand
by at most 20 context lines, capped at 200; stable line identities keep the
existing reading anchor. The backend owns git diff generation and lexical code
spans, outside Angular. Files above 400 changed lines or 1 MiB require explicit
loading. Text previews have an 8 MiB per-side, 200,000-line combined, 32 Ki-character line and 3 MiB
serialized-page ceiling. Binary/submodule entries expose metadata and no text
preview. Oversized content reports a readable limit instead of truncating code.

Reviews carry HEAD, base and target SHAs, an index/worktree fingerprint and
per-file content revisions. Committed and staged reads use pinned blob OIDs.
Working reads verify inode/ctime/nanosecond metadata before/after bounded access;
symlink targets are shown as text, never followed. Metadata capture validates the
index/working fingerprint on both sides of the git scan. A moving working file
is rejected, while already cached old text remains coherent. Metadata and text
caches have 64 MiB metadata / 16 MiB text budgets; snapshots expire after ten minutes. Missing
or evicted snapshots require refresh. No real index is modified.

While visible, a ten-second coalesced check offers **Update review** instead of
moving what the user reads. Applying it preserves selection and unchanged text
and Viewed revisions; only changed per-file revisions clear Viewed. Source/base
changes start another comparison; scope/task changes cancel prior reads and
reject late replies. Hidden/disconnected panels stop polling. Same-task snapshots
remain visible offline; recovery performs a read reconciliation and never replays
an action or prompt. Loading failures remain explicitly retryable.

`questionsAvailable=false` hides question controls for absent/archived conversations;
the connected owner also rechecks this read-only boundary before touching drafts.
`codeRequested` and `questionRequested` carry exact task/scope, review/file/content
revisions, path, line and old/new side. The connected owner appends questions to
the selected conversation's existing draft, returns to chat and focuses it after
the shell releases its inert region; it never sends them.
Code controls stay hidden until the owner sets `codeAvailable=true`; the connected owner currently reports Code navigation as unavailable (the parallel Code
feature can consume the typed intent without changing DiffReview). No filesystem
path, generic HTTP operation or shell capability is added to the bridge.
