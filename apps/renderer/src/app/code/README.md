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

The desktop owns lazy atomic artifact installation, isolated native surfaces and
private session-local HTTPS handling. There is no listening editor port. Its
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

The 440px panel shows task/branch identity and an explicit **Expand editor** action.
Expansion uses the existing shell takeover, gutters, motion and focus restoration.
At less than 600px usable width, **Open editor window** provides room to work.
That task-only window has its own selected-machine lease and the existing SSH
challenge UI; closing/changing the original window does not redirect its files.
One live workbench per task/machine is reused. Another window offers **Open editor
here** or **Focus editor** rather than silently stealing it. Four hot workbenches
are retained; clean hidden instances may close only after upstream permits unload.
Dirty instances stay retained. Shutdown respects backup vetoes.

### Space and focus decisions

The healthy expanded view has one compact task/branch toolbar. Connection status
shares that row; separate banners appear for lost connections, checkout changes
and failures. This leaves 752px for the workbench at a 1440 × 900 viewport,
compared with 696px before the UX pass. Upstream's own tabs and Explorer remain
genuine and configurable. Focus and separate-window actions use
the existing icon buttons, tooltips and keyboard states.

The redundant upstream “Code” title row is disabled using
`workbench.layoutControl.enabled: false`, alongside compact menus and the disabled
command center. Upstream reclaims that row for tabs and Explorer in both embedded
and separate windows. Layout commands remain available from the workbench menu
and Command Palette. `window.customTitleBarVisibility` is desktop-only and is not
used by this web workbench.

The launcher offers expansion and a secondary window action. A CSS query against
the shell's `workspace` container replaces these with one direct window action
when there is less than 616px: the 600px native minimum plus two `space-2` gutters.
Gutters exist in both launch and editing states, preventing resize oscillation
at the boundary. Loading has an explicit explanation until the workbench is
ready. The launch area scrolls in short windows, so keyboard actions remain
reachable. Shortcuts show the desktop platform's keys rather than two competing
key combinations.

Explicit expansion, opening a file and the focus control hand off to the current
task only after main acknowledges its visible native bounds. Stale acknowledgments
cannot steal focus after switching tasks. Restoring an existing wide panel does
not introduce an extra focus jump. A dedicated window uses `standalone` to omit
its own detach control and focus its retained workbench on launch. Returning to
chat uses the shell's existing focus restoration.

Changing transport invalidates the filesystem root once, without a tree snapshot.
After the rebound native view becomes visible, the surface invokes upstream's
Explorer refresh once as well: Explorer retains failed directory resolutions
separately from the provider. This clears handoff errors without replacing tabs,
selection or unsaved buffers, or rescanning on ordinary layout updates.

Tooltips outside the workbench bounds leave it visible. Intersecting overlays and
dialogs hide the native surface and show a quiet retained-editor message; closing
them returns the same workbench. A closed editor window is represented as retained
work, with no dead “Focus other window” control. Connection recovery is busy and
single-flight so repeated clicks do not start competing recoveries.

`WorkspacePanels` accepts `[workspaceCode]` / `#workspaceCode`. The production
owner supplies a `CodeTarget` from the selected task's captured scope, never from
the selected session. File intents include that target and are consumed once;
late intents/replies cannot open the old path in a different task. Changes review
can open a task-relative path with one-based line/column. Embedded
Command/Ctrl-Shift-R returns to chat; ordinary Escape remains VS Code's own key.
The shortcut is contributed through VS Code's supported keybinding API while
embedded, with Electron's input handler as a fallback. Its local view intent is
validated against visibility, window kind, checkout generation and transport;
it never sends a backend mutation. The binding is disabled in a separate window.

The workbench owns explorer, tabs, Quick Open, search, editing, language basics
and backups. Chrome uses the upstream textarea/CPU editor paths for predictable
embedded input/rendering. The app supplies its local fonts and token-derived
light/dark colors through supported configuration. No existing content animates
on first paint; only supplied shell/feedback motion is used. Hidden surfaces are
removed from native focus/hit testing. Menus and modal layers hide the native
surface while retaining its model.

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

The editor has no preload, Node or Elevenex bridge. It has a separate persistent
Electron partition, authenticated by ownership of its private HTTPS handler.
Backend local access uses a private process capability; SSH uses the existing
private socket/transport capability. Origins, resource paths, replies, sizes,
scopes and generations are checked. Root or descendant symlinks cannot broaden
permissions; Git metadata is hidden. Task finish/reallocation invalidates reads,
search cursors and watches; mutations share the existing repository lifecycle lock.

The shell `app://` CSP is unchanged. The separate upstream surface needs inline
styles, blob workers and WASM. Only its isolated extension-worker origin permits
CommonJS evaluation; the pinned iframe's inline code is hash-allowlisted. External
network, navigation, arbitrary frames and device permissions are denied. The
private main document may retain persistent browser storage and perform focused
clipboard writes; clipboard reads and external filesystem pickers are denied.
HTTP/code caches are distinct from durable task writing. Editor content never
receives transport credentials or a generic HTTP/filesystem/shell bridge.

Filename and text-search registration use upstream's proposed provider APIs,
explicitly enabled only for the bundled extension. Their installed definitions
match the pinned runtime; an upstream upgrade must update and retest them together.
Filesystem pathname checks and save revisions do not replace an OS sandbox against
malicious concurrent directory replacement; see the verification limitations.

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

Only browsed directories are watched (64 per task, eight tasks); active clean
text documents also reconcile stat changes. Cursor overflow requests visible
resource reconciliation. Closed views/tasks release subprocesses, requests,
subscriptions and observers; idle backend watches/searches expire. Symlinks and
invalid platform names are not editor resources. POSIX Unicode, quotes, spaces,
newlines and ordinary literal backslashes are transported as data, never shell.
Native extensions, terminals/debuggers and arbitrary webviews are outside this
confined web-editor feature. Use the application's corresponding task panels.
