# Side views

Import standalone components and readonly models from `./index`. These are UI
boundaries: they do not launch terminals, run scripts, make network requests,
generate diffs, or access the filesystem. Outputs carry stable IDs, not positions.

`ViewTabs` provides arrow/Home/End selection, Delete and middle-click close, native
focus and animated entry/exit. Browser and Terminal reserve Command/Ctrl-T while
focused and expose `selected`, `closed` and `added`.

`BrowserView` accepts a trusted `[browserPreview]` projection. It does not create
iframes, webviews, or turn arbitrary URLs into privileged content. Every navigation
or browser capability is an intent output. `driver` remains controlled: preview
pointer/keyboard input emits `takeOverRequested` immediately while the agent
drives, and the owner must stop that agent before accepting user input. The UI
does not promise secret-field masking; the browser integration must enforce it.
`asked` carries the selected target, text and active tab identity. Screenshot
capture and source resolution also belong to the future browser integration.

While the agent drives, the active agent tab breathes and an overlay paints the
accent frame above the projected page. The target ring and cursor follow page
coordinates, including phone width and scrolling. The workflow bar crossfades
step text and bounds its dots to twelve for long workflows. Errors are shown
after control returns to you, matching the design’s single driving status bar.
Reduced motion stops the cursor pulse, tab breathing and target travel. The
isolated `BrowserDemo` measures its sample button with an owned ResizeObserver;
the production browser owner must supply its own page coordinates.

`TerminalView` accepts `[terminalContent]` for a future terminal adapter. Its text
preview uses escaped `TerminalLine` objects and CDK virtualization, bounded to the
latest 2,000 lines; any omitted history is labelled. It emits typed script,
failure, port and stop intents. Ports are validated before emitting `portOpened`.
Do not put the agent's tool output in this view.

`DiffReview` accepts metadata as `ChangeFile[]` and precomputed
`DiffFileContent[]`. Each content reply must match **fileId, rev and mode**. The
owner generates diffs off the UI thread and rejects stale asynchronous replies.
The review emits coalesced `fileRequested` intents when a file approaches the
viewport, and explicit retry/large/more requests from `DiffFile`. The loader should
limit concurrent requests (normally three), cancel them with its task/window,
and supply bounded pages. `contextRequested` asks for at most 20 lines at a time.

The file list uses CDK virtualization. To keep repositories with thousands of
files responsive, the review renders 12 files per page and 400 lines per file
page. Every file is reachable through the virtualized jump list and public
`goTo(fileId)`; explicit Previous/Next controls expose every page. `remainingLines`
supports upstream content pagination. This bounds DOM size even for a giant
generated change. It deliberately replaces the reference's unbounded all-file
stream with bounded pages while preserving a continuous review within each page.

At compact widths, navigation and review tools occupy separate toolbar rows so
filenames remain readable. `ChangeList.selected` follows arrow/Home/End navigation;
`activated` confirms with Enter, Space or a click. The jump dialog stays open while
browsing and restores focus to its trigger when confirmed or dismissed. Explicit
file jumps retain their selection at the bottom of the scroll until the user
scrolls, even when a short last file cannot align to the top.

File headers use one `row-height` row, with inline folder context and independent
counts/actions. Hover highlights the collapse chevron rather than the entire
filename region. Updates use a labelled glyph instead of an extra banner row.
The review owns pinned-header presentation, using its existing bounded scroll
pass and a cleaned-up layout observer. Header height is measured for reading
anchors and change navigation. Collapse and Viewed align a pinned file before
its body folds; changing Viewed resets any temporary expansion of that file.

`DiffFile` owns collapse state, line-question drafts and sent local notes; the
owner controls Viewed flags and clears them when revisions change. A changed
revision invalidates local content/drafts. Comments include the correct old/new
side, line number and revision. Tokens arrive as typed `CodeSpan[]`; code is
interpolated as text and never rendered as HTML. The review keeps a reading anchor
by file and line identity across content/mode/wrap changes and aligns a sticky
file header before marking its long body Viewed. Preserve line IDs when expanding
context so that this anchor remains meaningful.

`wideChange` asks the shell to animate the review over its chat region. Supply
`wide` explicitly during that animation so the file column/gutters move with the
panel. The shell owns the actual takeover and restoring the chat. Escape,
Command/Ctrl-Shift-R, Alt-Up/Down, V and F7/Shift-F7 are handled while review is
focused; editable fields retain their normal keys.
Set `showWideToggle=false` when the containing panel already supplies an expand
button. This hides the review's duplicate button while keeping its keyboard
shortcut and controlled `wide`/`wideChange` behavior.

Sample data is isolated in `apps/renderer/preview/`. The production components
contain no fixtures or platform calls.


`fullFilesAvailable=false` hides Full files when a source provides recorded diffs
only. `openFilesAvailable=false` on `DiffReview`/`DiffFile` hides Code opening when
that platform operation is unavailable. Defaults preserve existing consumers.
`DiffFileContent.hasMoreLines` supports cursor-based content sources without a
known remaining count; it shows “More lines available” and emits the existing
`more` request, alongside the existing exact `remainingLines` option.

For replacement content windows, set `hasPreviousLines` to expose Previous lines
on that file. It emits `reason: 'previous'`; the owner supplies that earlier page
with the same file/revision/mode identity. This keeps line paging attached to the
file while scroll-based selection moves between its neighbours.
