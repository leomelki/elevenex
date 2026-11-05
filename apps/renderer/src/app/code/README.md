# Task Code workbench

See [verification, measurements and remaining limits](./VERIFICATION.md) for the
actual checks and platform coverage; this guide describes the implementation.

Code is the genuine **Code OSS Web workbench**, not a Monaco replacement. It
belongs to the task across conversations. Its stable virtual folder/storage ID is
separate from the checkout generation and the window's transient backend scope.
This preserves tabs, selection and upstream hot-exit buffers across task switching,
reconnect, renderer recovery and checkout changes.

## Architecture decision

Microsoft's downloadable `web-standalone` distribution has Remote Development
license terms prohibiting integrated redistribution. A native OpenVSCode/VSCodium
remote agent has filesystem/terminal access beyond its working directory; that
cannot enforce the required task boundary by itself. Neither is our runtime.

We pin the unmodified MIT Code OSS **1.144.0** web build published as
`code-oss@1.144.0` by YieldRay, with the exact npm SHA-512 integrity in
`apps/desktop/src/code/artifact.ts`. Its public build runs upstream's
`vscode-web-ci` task. The publisher/npm HTTPS and pinned bytes are distribution
trust roots; this is not a Microsoft-endorsed distribution. Only browser assets,
built-in web extensions and their notices are used. The publisher's convenience
bootstrap and all native server executables are unused. No npm dependency is added.

Sources: [upstream embedder API](https://github.com/microsoft/vscode/blob/1.144.0/src/vs/workbench/browser/web.api.ts),
[official web test host](https://github.com/microsoft/vscode-test-web),
[artifact build](https://github.com/YieldRay/vscode-web-build/blob/main/.github/workflows/build.yml),
[Microsoft distribution terms](https://code.visualstudio.com/license).

The desktop owns lazy atomic artifact installation, cross-origin sandboxed iframes and
private session-local HTTPS routing. There is no listening editor port. Its
sandboxed web extension speaks named file/search operations; main validates and
forwards them through the existing per-window local/SSH backend client. Backend
modules separately own authoritative task/checkout validation, file revisions,
ripgrep search, bounded watches and task-lifecycle cleanup. No previous editor
frontend, backend, extensions or packaging are reused.

Assets install outside the checkout under desktop application data, once on first
use. The install streams, bounds bytes/expansion, verifies the immutable digest,
extracts confined regular entries, validates required assets and atomically
publishes a completion marker. Warm installs work offline; a failed install is
retryable. Two artifact versions are retained. Source maps are omitted. Remote
machines need the new backend and its existing ripgrep platform dependency; editor
assets and browser processes remain on the desktop. Existing legacy packaging
commands retain their defaults. Packaging includes the new extension, source
license and authoritative tokens, not the downloadable runtime.

## UX and ownership

The 440px side panel opens a genuine editor directly, alongside chat. The existing panel-tabs row
contains icon actions for **Browse files**, **Search text** and a separate window,
alongside expand/close. There is no additional task/branch/status/focus toolbar. File tabs,
selection and save feedback remain native VS Code. Files auto-save after one second
of inactivity using upstream `files.autoSave: afterDelay`; Command/Ctrl-S still
saves immediately. Save failures use VS Code’s error notifications and retain
local edits. Conflicts require a disk comparison before an explicit overwrite;
reconnecting never retries an unconfirmed write. There is no shell Save button
or extra save status in the panel header.

Below 600px usable width, editing uses the full panel and long lines wrap.
**Browse files** (folder icon, Command/Ctrl-Shift-E) temporarily fills that same
Code area with the genuine VS Code file tree. It never squeezes the file into
another narrow column. **Find file…** replaces the `/` folder title at the left
of the native file-tree header, with New File/New Folder remaining on the right.
Its VS Code `view/title` action opens the same Quick Open picker as Command/Ctrl-P,
retaining native click handling, keyboard focus, tooltips and themes. The target
fills the available left header space at the standard 30px control height, with
8px inner padding and a gap before the creation actions. Its quiet background
strengthens on hover/focus, and long labels truncate without crowding the actions.
The action is scoped to compact Files; expanded
Explorer keeps its usual controls. No extra shell search row occupies editor space.
Command/Ctrl-P remains available in the workbench at every size.
Folder clicks/arrow keys keep browsing; a single file
click or Enter opens it and returns to full-width editing. Selecting the already
open file does the same. On macOS, compact Enter accepts a file rather than
starting rename; expanded mode retains upstream bindings.

With no editor tabs, Files is the default view. Closing the last tab returns to
it. With open tabs, the folder action becomes **Back to editor · Esc** while
browsing. Escape, Back or Command/Ctrl-B returns to the retained editor, cursor,
scroll position and unsaved writing. Renaming, inline find and context menus
consume their own Escape first. Back remains a local view action when offline.
The tree keeps its expansion/selection state across visits.

The same native `workbench.explorer.fileView` moves into the bundled extension’s
Files container and is maximized over the editor area. No editor is closed and
no second file tree, filesystem bridge or repository snapshot is introduced.
At 600px, it moves back into normal Explorer and restores the activity-bar and
word-wrap preferences journaled before compact mode. Layout work is serialized;
resizing never reloads the document. Find file still uses upstream Quick Open;
Search uses Quick Search, including Command/Ctrl-Shift-F while compact.

The iframe fills the available panel at every size. There is no native-surface
minimum-size gate or forced Expand placeholder. Expansion uses the existing
shell takeover, motion and focus restoration; the separate-window action stays
available in the panel toolbar.
That task-only window has its own selected-machine lease and the existing SSH
challenge UI; closing/changing the original window does not redirect its files.
One live workbench per task/machine is reused within its owning window. Moving
to another window waits for upstream hot-exit backup vetoes to clear, then restores
the editor under the destination window’s independent backend lease. Another window offers **Open editor
here** or **Focus editor** rather than silently stealing it. Four hot workbenches
are retained; clean hidden instances may close only after upstream permits unload.
Dirty instances stay retained. Shutdown respects backup vetoes.

`CodePanel.active` controls platform operations and focus; optional `retained`
keeps only its visual frame mounted during the shell's inert closing slide.
The production owner binds retention to `AppShell.panelPresent`. The viewport
suspends measurement and any in-progress snapshot at its current painted state
while inactive, then parks the same iframe only after closing completes. Reopening
resumes measurement without reloading the document. Changes review uses the same
shell lifetime to keep its loaded contents through exit.

Ordinary panel opening/closing clips the retained editor at its existing width.
It adds no resize cover or snapshot and does not wait for layout acknowledgement
to reveal: a loaded workbench is visible immediately during the slide. Only a
change in the editor viewport uses the resize transition below.

Expansion/collapse predicts the destination from the shell's actual width
transition, including percentage widths, and resizes the iframe once at the start.
An element-scoped View Transition retains the old editor image while the new one
renders underneath. The shell retains its original 280ms width/opacity glide;
Code never finishes it early. ResizeObserver fits the outer compositor surface to
the moving viewport using scaleX, without relaying intermediate widths to the
iframe. Both images stretch with that surface and blend in a 140ms token-driven
effect with a 16px blur derived from the glass and spacing tokens. Blur starts
one third into the shell glide (about 93ms). Its opaque midpoint holds the old image until the child's layout
acknowledgement, then the remaining half crossfades and clears the new image.
An early acknowledgement adds no wait; a later one resumes immediately. Timing
follows the shell's actual animation clock, including interrupted transitions.
At the end, scale is already 1, so removing it cannot expose a final resize jump. The
old image stays visible instead of a blank hide/show phase. Panel controls and
the surrounding application stay outside the snapshot's hit-test boundary. No
screenshot/pixel API is added to the bridge.
The iframe is a direct, temporarily named transition participant rather than
being flattened into a wrapper snapshot; its incoming cross-origin surface stays
live as Code paints the destination layout.

`codePresent` with the expected `viewportWidth` first awaits the child's actual
viewport commit, then applies compact/expanded commands. This order keeps new
Explorer/wrap settings out of the old compositor surface. Two stable child paints
and completion of layout animations acknowledge readiness, without the previous
fixed 120ms quiet delay. The new snapshot stays opaque under the old image so
Chromium continues rendering the cross-origin workbench. Caret opacity animations
do not delay readiness. The bounded two-second failure path still exposes retained
writing and an error; it is not a normal animation delay.

Unsupported scoped transitions retain the covered fallback. Reversals, context
changes, reduced motion and teardown cancel retained snapshots and pending work.
An unexpected destination change during native window resizing reconciles under
an immediate cover. The same iframe and input remain active throughout. Ordinary
window resizing remains live, and launch/modal transforms never change compact
preferences because measurements use layout pixels. ResizeObserver retains an
explicit settled pixel width between toggles too, preventing Chromium from
publishing a tiny first animation step before the transitionrun listener executes.

### Space and focus decisions

The healthy view starts immediately with the upstream workbench and its file tabs,
inside 4px gutters. Connection status is already available in the native status
bar; separate banners appear only for lost connections, checkout changes and
failures. The task header alongside chat identifies the task and branch. Native
Explorer remains configurable, and all projected actions use existing controls.

The redundant upstream “Code” title row is disabled using
`workbench.layoutControl.enabled: false`, alongside compact menus and the disabled
command center. Upstream reclaims that row for tabs and Explorer in both embedded
and separate windows. Layout commands remain available from the workbench menu
and Command Palette. `window.customTitleBarVisibility` is desktop-only and is not
used by this web workbench.

Expanded and standalone workbenches hide the Run and Debug and Extensions
navigation buttons. Explorer, Search and Source Control remain visible. This
presentation is scoped to the pinned upstream composite-bar items; it does not
remove upstream commands or add debugger/extension support.

The workbench has a uniform 4px (`space-1`) gutter on all four sides, in both
launch and editing states. The frame remains mounted through transient opening widths and short layouts.
Artifact preparation and genuine failures retain explicit explanations. Once
main supplies an editor URL, the mounted iframe loads behind an opaque `surface`
cover and the progress line. The cover also keeps startup controls inert. Main
applies the native theme and compact layout together, then checks stable child
layout frames before acknowledging presentation. The cover disappears immediately
on that acknowledgement, with no fixed startup delay or fade; retained editors
stay uncovered during later layout changes. The launch card never occupies space
beside or underneath the iframe. Short
windows scroll launch/recovery actions into reach.
Shortcuts show only the desktop platform's keys. No redundant task identity row consumes editor height.

Explicit expansion, opening a file and programmatic focus hand off to the current
task only after main acknowledges its visible frame presentation. Stale acknowledgments
cannot steal focus after switching tasks. Restoring an existing wide panel does
not introduce an extra focus jump. A dedicated window uses `standalone` to omit
its own detach control and focus its retained workbench on launch. Returning to
chat uses the shell's existing focus restoration.

Toolbar intents cross a fixed `CodeAction` union (`browse-files`, `dismiss-files`,
`find-file`, `search-text`, `save`), validated in main and restricted to the visible owned task and current
backend scope. No caller-supplied VS Code command ID crosses the bridge. Save is
an explicit single action and uses the existing revision/conflict safeguards.
The browser extension's focused modules are bundled with the esbuild already
provided by Angular, with only the upstream `vscode` module external.

Changing transport invalidates the filesystem root once, without a tree snapshot.
After the rebound frame becomes visible, the surface invokes upstream's
Explorer refresh once as well: Explorer retains failed directory resolutions
separately from the provider. This clears handoff errors without replacing tabs,
selection or unsaved buffers, or rescanning on ordinary layout updates.

Menus, tooltips and modal layers paint above the iframe using ordinary DOM
stacking. The editor remains visible beneath them and participates in the shell’s
background recession. Modal focus trapping and inherited `inert` apply normally;
there is no overlay scanning, native-surface hiding or placeholder substitution.

`WorkspacePanels` accepts `[workspaceCode]` / `#workspaceCode` and a
`[codeActions]` template. Bind the latter to `CodePanel.actions() ?? null`; it
projects the feature-owned controls into the existing panel-tabs row only while
Code is selected. Standalone editor windows have no additional toolbar. The production
owner supplies a `CodeTarget` from the selected task's captured scope, never from
the selected session. File intents include that target and are consumed once;
late intents/replies cannot open the old path in a different task. Changes review
can open a task-relative path with one-based line/column. Embedded
Command/Ctrl-Shift-R returns to chat; ordinary Escape remains VS Code's own key.
The shortcut is contributed through VS Code's supported keybinding API while
embedded. Its local view intent is
validated against visibility, window kind, checkout generation and transport;
it never sends a backend mutation. The binding is disabled in a separate window.

The workbench owns explorer, tabs, Quick Open, search, editing, language basics
and backups. Chrome uses the upstream textarea/CPU editor paths for predictable
embedded input/rendering. The app supplies its local fonts and token-derived
light/dark colors through supported configuration. No existing content animates
on first paint; only supplied shell/feedback motion is used. Hidden frames are parked in a hidden, inert window-owned container.
Chromium’s state-preserving `moveBefore` retains their browsing contexts, workers,
selection and unsaved writing across task switches and Angular owner teardown.
The frame pool owns component cleanup; main owns the bounded retention budget.

Selection, Quick Open, input focus and syntax colors also use the authoritative
palette through upstream `workbench.colorCustomizations` and
`editor.tokenColorCustomizations`; see [upstream theme configuration](https://code.visualstudio.com/docs/configure/themes#_customize-a-color-theme).

## Recovery and security

Every operation revalidates the task and physical checkout. Checkout changes
require explicit acceptance; retained dirty files still carry their original
generation. Writes capture a transport revision before awaiting storage/network
work, so a late operation cannot acquire a new backend scope on reconnect.
File saves compare content revisions. A bounded extension workspace-state journal
persists a sending claim **before dispatch**, alongside upstream hot-exit backups.
Unknown writes stay blocked across restart. Read-back confirmation can acknowledge
identical saved bytes without replaying a write. Otherwise **Inspect unconfirmed
task save** / the editor status opens a read-only disk comparison; **Save my
version** explicitly adopts that reviewed revision, with another server-side
conflict check. Read-only files and failed/conflicting/unconfirmed saves retain
local writing. No mutation is replayed on reconnection.

The editor has no preload, Node or Elevenex bridge. It uses a persistent origin derived from machine configuration and task identity,
with a separate worker subdomain. The frame router checks window ownership and
request initiators before its private HTTPS handler receives any request. There
is one router for the shell session, not one conflicting handler per task.
Backend local access uses a private process capability; SSH uses the existing
private socket/transport capability. Origins, resource paths, replies, sizes,
scopes and generations are checked. Root or descendant symlinks cannot broaden
permissions; Git metadata is hidden. Task finish/reallocation invalidates reads,
search cursors and watches; mutations share the existing repository lifecycle lock.

The shell `app://` CSP allows frames only beneath `https://*.code.elevenex.invalid`;
shell scripts, styles and networking retain their existing restrictions. The
router denies unregistered origins even beneath that suffix. The editor’s
`frame-ancestors` permits only itself, its worker family and the exact shell
origin (the precise loopback origin during development). The separate document needs inline
styles, blob workers and WASM. Only its isolated extension-worker origin permits
CommonJS evaluation; the pinned iframe's inline code is hash-allowlisted. External
network, navigation, arbitrary frames and device permissions are denied. The
private editor document may retain persistent browser storage and perform focused
clipboard writes; clipboard reads and external filesystem pickers are denied.
HTTP/code caches are distinct from durable task writing. Editor content never
receives transport credentials or a generic HTTP/filesystem/shell bridge.

Filename and text-search registration use upstream's proposed provider APIs,
explicitly enabled only for the bundled extension. Their installed definitions
match the pinned runtime; an upstream upgrade must update and retest them together.
Filesystem pathname checks and save revisions do not replace an OS sandbox against
malicious concurrent directory replacement; see the verification limitations.

## Implementation boundaries

- `CodeFramePool` owns retained DOM/component instances for one renderer window.
  `CodeFrameComponent` declares the iframe sandbox and has no platform calls.
  The pool validates main-issued URLs before creating a trusted resource URL.
- `CodePanel` owns selection, measurements, frame mounting and stale focus checks.
  `codePresent(target, {visible, compact, viewportWidth?})` is the named presentation
  contract; the optional bounded width requests a hidden-layout acknowledgement.
  The older `codeLayout` operation remains a compatible adapter for existing callers.
- `CodeSurfaces` owns task leases, bounded retention, recovery and window handoff.
  `CodeFrame` confines privileged commands to the exact owned direct child frame.
  `layout-settlement` observes bounded workbench geometry inside that frame and
  owns its deadline, animation frame and cancellation/page-hide listeners.
- `CodeFrameRouter` owns session routing, frame navigation and permission policy.
  `CodeProtocol` owns confined assets, task operations and generation checks.

`CompactLayout` owns the file-view placement, compact preference journal, tab
subscriptions and restoration. A small workbench-owned `FilesFocus` adapter
handles accessible tree-item activation and editor focus: the public extension
API does not report accepting the already active editor. It sets one document
class for the compact header presentation, excludes folder
expansion, rename inputs and modified clicks, and removes that class and both
listeners on pagehide. The scoped header CSS hides the redundant folder title and
aligns the existing native Find file action at the left and restores the original
header outside compact browsing. Native controls keep their own event and
keyboard handling.
Keep its native mouse/keyboard regressions
when upgrading the pinned workbench. Main validates generation/transport-bound
presentation booleans before publishing Files/Back state to the selected task.

App-owned extension assets use `/extension-v2/` and `no-store`. The new prefix
escapes immutable cached responses from the original iframe host; the former
path remains a compatible alias. Pinned Code OSS assets retain their immutable
cache, and storage/task IDs stay unchanged.

The iframe uses `allow-scripts allow-same-origin` so upstream workers and IndexedDB
work. It is always cross-origin from the shell, so it cannot remove its sandbox
or reach the parent DOM/bridge. Forms, popups, downloads, top navigation and device
permissions remain unavailable. No generic `postMessage` command dispatcher or
listener port is introduced. Storage persistence is requested without delaying
workbench startup. Existing native-editor partitions are left untouched; this
change does not import their development-profile browser storage into the new
iframe origins.

## Bounds and supported scope

Files are at most 8 MiB. Directory transport pages contain 200 entries; upstream's
single-directory API materializes at most 10,000 children and offers Quick Open
for larger folders. Filename indexes run beside the files, are shared across
keystrokes for the same folder/glob/ignore options, and are bounded to four
12 MiB / 100,000-name entries. No tree/content snapshot crosses IPC. Query results
are limited to 200 filenames; text search streams pages of at most 100 rows /
192 KiB, up to 2,000 matches, with bounded queues and cancellation. Overflow is
explicit. Task-local ignore files apply; global/parent ignores are excluded from
the task boundary. Search is single-line ripgrep/Rust-regex search.

Saving preserves existing POSIX permission bits. New files publish complete bytes
with an atomic hard link from a temporary file in the same directory, so a failed
publication leaves no empty file and a concurrent creator is never overwritten.
Filesystems without hard-link support cannot create files through Code; the save
fails and retains the editor buffer. Existing-file saves still use atomic rename.
Create/overwrite flags are enforced by the filesystem provider. Confirmed deletion
clears the old save baseline; file/folder rename moves descendant baselines and
generation metadata. A folder with an unconfirmed or pending child save must be
reconciled before renaming. Nonempty recursive deletion and replacing a rename
destination are intentionally unsupported.

Only browsed directories are watched (64 per task, eight tasks); active clean
text documents also reconcile stat changes. Cursor overflow requests visible
resource reconciliation, including a batch with more than 128 distinct folders.
Connection failures retain open files; only a file-not-found reply reports deletion.
Closed views/tasks release subprocesses, requests,
subscriptions and observers; idle backend watches/searches expire. Symlinks and
invalid platform names are not editor resources. POSIX Unicode, quotes, spaces,
newlines and ordinary literal backslashes are transported as data, never shell.
Native extensions, terminals/debuggers and arbitrary webviews are outside this
confined web-editor feature. Use the application's corresponding task panels.
