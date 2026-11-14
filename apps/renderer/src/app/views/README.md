# Side views

Import standalone components and readonly models from `./index`. These are UI
boundaries: they do not launch terminals, run scripts, make network requests,
generate diffs, or access the filesystem. Outputs carry stable IDs, not positions.

`ViewTabs` provides arrow/Home/End selection, Delete and middle-click close, native
focus and animated entry/exit. Set `animateEntries=false` while attaching an
existing tab window; `TerminalView.animateTabs` forwards this policy. Browser and Terminal reserve Command/Ctrl-T while
focused and expose `selected`, `closed` and `added`.
Both views share the same strip: short dividers separate idle tabs and disappear
beside the selected or hovered tab. Hover is softer than selection. Edge fades
indicate overflow without numbered controls or a scrollbar; trackpad swipes and
ordinary mouse wheels browse tabs without selecting them. Selection and new-tab
entry reveal the whole tab inside this strip without moving the page or stealing
focus. Metadata updates preserve manual browsing. Reduced motion reveals tabs
instantly and disables the fades' transitions.

`BrowserView`'s `canGoBack` and `canGoForward` inputs control the history buttons; handle
`backRequested` and `forwardRequested` in the owning platform adapter. Both default
to disabled and respect `controlsDisabled` for tabs hosted in another window.
The New button follows the last tab; the strip takes only the width its tabs need
and scrolls with edge fades once it fills the row. Content marked `viewTabsNew` is
projected directly after New; other projected actions stay right-aligned.

`BrowserView.localTabsAvailable` adds a chevron beside New with remote/local
creation intents (`added` / `localAdded`). The toolbar pill shows **Local** by
default, **Local · Proxied** with `trafficViaServer=true`, or **Streaming** with
`streaming=true`, independently of agent activity. Streaming takes precedence.
`localOnly` hides agent workflow/error surfaces, explains agent exclusion in the
location tooltip and opens `moreRequested` for details. `trafficViaServer` also supplies routing copy to its
keyboard-accessible tooltip. The owner must also disable picking and enforce the
privacy policy at the engine boundary. These inputs default off for older callers.

`BrowserView` accepts a trusted `[browserPreview]` projection. It does not create
iframes, webviews, or turn arbitrary URLs into privileged content. Every navigation
or browser capability is an intent output. `driver` remains controlled and
reports current activity rather than a user/agent mode. `takeOverRequested`
means the explicit **Block agent** action; `handBackRequested` means **Allow
agent** (or completion of a human workflow). `agentWaiting` shows an explicit
block. Page input and page focus never emit the block intent: the platform adapter
interrupts current automation at its input boundary and permits fresh acquisition.
The UI does not promise secret-field masking.
`asked` carries the selected target, text and active tab identity. Screenshot
capture and source resolution remain platform capabilities. The production
[task browser adapter](../task-browser/README.md) owns the real isolated Electron
page, task persistence, control leases and privacy policy.

Point and ask is controlled by `picking`, `hovered` and `picked`; the owner does
the inspection. While picking without a pick, the view shows a non-interactive
`review` frame and hint pill above the page, hides the agent frame, cursor and
target, and emits `pickingChange(false)` for Escape from anywhere in the view. If a
page shortcut starts picking while focus is outside the view, the preview takes
focus so Escape works. Supply `hovered` only when the platform can inspect the
element under the pointer; its ring follows without easing. The host consumes selection clicks without activating the page. `capturePending` locks the hover ring and changes
the existing hint to capture feedback without resizing the page. Streamed clicks
receive immediate local acknowledgement while host state arrives; this never
stages a reference or claims capture succeeded. Escape cancels even when streamed
input consumes its own keyboard events. Set `pickerReady` from the host’s current
input readiness so the hint explains preparation instead of inviting a click
before the page can accept it.
The page itself must
receive the click, so the view never intercepts page pointer input. With `picked`,
the question card is positioned in page coordinates beside the element (under,
then over), or docked across the visible page at the edge away from it when the
page is under 400px wide, the element is out of view, or there is no room beside it.
The card measures the page and itself with an owned `ResizeObserver` and scroll
listener, both removed with the card. The card's target button emits
`pickingChange(true)` to pick another element and keeps the draft; the toolbar
button and Command/Ctrl-Shift-C stay pressed while asking and toggle point and ask
off. `askNote` adds one muted line saying what the question carries. Escape or ×
dismisses and restores focus to the previous control, or to the toolbar button
when the pick left focus inside the page.

While the agent drives, the active agent tab breathes and an overlay paints the
accent frame above the projected page. The target ring and cursor follow page
coordinates, including phone width and scrolling. The workflow bar crossfades
step text and bounds its dots to twelve for long workflows. Errors are shown
after control returns to you, matching the design’s single driving status bar.
Reduced motion stops the cursor pulse, tab breathing and target travel. The
isolated `BrowserDemo` measures its sample button with an owned ResizeObserver;
the production browser owner must supply its own page coordinates.

Owners opening Browser Tools from `moreRequested` can pass `toolsOrigin()` to
`ModalLayer.from`. This supplies the native toolbar button for motion and focus
restoration, including platforms where mouse activation does not focus buttons.

`cursor?: BrowserCursor` supplies an independent viewport-CSS position and a
monotonic `pulse` identity. The same cursor element glides between updates on
`dur-slow`/`ease-glide`; a new pulse triggers one finite ripple. Without this
input the existing `action` target supplies the compatible cursor position.
The agent pointer uses a faceted accent arrow and sparkle with a contrasting
surface outline. Its tip and click ripple align with the supplied page coordinate.
All decoration is inert, ignores pointer input, and fades out on takeover or
point mode. Reduced motion applies positions immediately and disables ripples.
`step.status` optionally supplies running, waiting, done or error; the shared
status glyph, caption and bounded step dots reflect it without moving focus.
The Block agent/Allow agent control keeps its DOM identity through those updates.
The `/browser-agent` preview shows the controls, target/cursor and completion;
`browser-agent-feedback.mjs` captures motion, interruption and both themes.

`TerminalView` accepts `[terminalContent]` for the [production user-terminal adapter](../task-terminal/README.md).
Its `[terminalActions]` slot projects owner-supplied toolbar actions beside Find; the
owner retains menu lifecycle, capability checks and typed platform operations.
Its text preview uses escaped `TerminalLine` objects and CDK virtualization, bounded to the
latest 2,000 lines; any omitted history is labelled. It emits typed script,
failure, port and stop intents. Ports are validated before emitting `portOpened`.
Do not put the agent's tool output in this view. `disabled`, `askDisabled` and
`rerunDisabled` control platform actions. `searchRequested` carries query/direction
to the real adapter; `findStatus` displays its bounded match count or “No results”.
The optional `findMatches` count disables navigation for zero matches (null means
unknown). When scripts are supplied, `TerminalLauncher` adds a chevron beside New that
opens a searchable launcher: New shell, then the project's scripts with their
commands. Its field is focused on open, so typing filters immediately; arrows
move the active option, Enter launches, and Escape, Tab or an outside click
closes and restores the chevron's focus. Matches are bounded to 50 rows with a
“refine the search” note. It is a combobox dialog rather than a menu because it
holds a text field. The Find button stays at the right edge of the tab bar. It
opens a compact folding row with a single focus border, previous/next buttons
and Close. The row collapses completely when closed unless the selected terminal
is serving a local port; its service-port badge, browser action and Stop share
one row and return when Find closes. Each `TerminalTab` may carry controlled
`browser: TerminalBrowserFeedback` (`busy`, `error`, `url`, optional `copyBusy`
and `copied`). The URL is visible immediately, using the tab's observed `url`
or a loopback HTTP address for older callers. The address opens the browser;
the separate Copy URL icon emits `portCopyRequested` without opening it. Both
carry the service port so the owner can resolve the actual local address.
Resolved addresses replace the initial URL. Long URLs truncate with their full
value in the tooltip and accessible name. Opening/copying disables duplicate
requests while leaving Stop available. The URL stays visible through pending
and error states; failures show an alert beneath the controls. `copied` changes
the copy icon to a check and announces success. Switching tabs never reuses
another tab's address. The owner supplies feedback and handles platform intents;
the view does not navigate or access the clipboard. Ordinary running commands do
not open a Stop-only row; use Ctrl-C in the terminal to interrupt them.
Enter/Shift-Enter navigates; Command/Ctrl-F opens or focuses
and selects the current query. Close/Escape clears the search and restores the
opening control's focus, including when a search action has focus. The preview
output contract remains available.

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

The optional `addressEditable` input enables an accessible address draft;
`navigated` emits its nonempty value only on Enter, clearing address focus.
An empty submission keeps focus. Page updates preserve an unfinished
draft, and changing tabs resets it. `askLabel` defaults to “Ask”; integrations
that stage a draft use “Add to composer”. The presentational component still
performs no platform navigation or prompt submission itself.

Targets use page viewport CSS coordinates in the native adapter. Positions may
be negative when an element is partly scrolled out of view; widths/heights remain
nonnegative and the preview clips the ring naturally.

The browser workflow footer remains visible for every agent-controlled tab,
even without step metadata. **Stop agent** emits `takeOverRequested`; the owner
must revoke access and pause acquisition until **Hand back**. The same button
retains keyboard focus when it changes to Hand back.

`pageFocusRequested` lets a platform owner focus its actual page from the driver
pill. `pageFocusAvailable=false` disables that action for unavailable
surfaces. The projected HTML preview retains ordinary keyboard focus behavior.

Production Browser sets `keepPreviewMounted` so its trusted platform slot stays
measurable before the first navigation, and `clipPreview` so page scrolling stays
inside the browser. Both default to false for existing decorative consumers.
Platform guests/streams and their ownership live in `task-browser/`, outside this
presentational family.

The workflow uses one retained footer for driving and waiting, with a reserved
progress row at narrow widths. Error counts stay in the workflow controls during agent work.
This avoids a page resize in the middle of the user's takeover click. These are
presentation choices; driver authority is always enforced by the platform adapter.

Browser owners may set `detachable` and handle `detachRequested` for the current
tab; `detachBusy` disables duplicate requests. `showTabs=false` presents a single
bound page and ignores the new-tab shortcut. `controlsDisabled` disables page
controls for a tab displayed elsewhere while preserving its tab-strip identity.
`pickerAvailable=false` hides picking when the owner has no composer destination.
All defaults preserve existing preview and product callers.

`ViewTabs.reorderable` enables CDK dragging and Alt+Shift+Left/Right on a focused
tab. Its `moved` output carries `{tabId, beforeTabId}` (null appends); the owner
applies authoritative order. `detachable` emits `windowRequested` with the dragged
tab ID on a deliberate vertical drop at least 48px outside the strip. Horizontal
overflow never detaches. Escape cancels a gesture; tab membership changes cancel
stale indices. `tabsBusy` gates both gestures while a mutation is pending.
`BrowserView` forwards these as `tabMoved` and `tabWindowRequested`, alongside its
existing current-tab window button. Terminal retains its existing defaults.
`ViewTabs` reveals the controlled selection within its own horizontal strip,
including while a newly created tab grows in, and keeps it clear of the edge
fades. Overflow is signalled only by those 24px fades; the scrollbar is hidden.
Trackpads scroll natively and a vertical mouse wheel scrolls the strip
horizontally. New stays fixed outside it. Wheel/drag browsing suspends selection
following until selection changes, so metadata updates never pull the strip
back. Selection jumps scroll smoothly (instant under reduced motion); growth
tracking is immediate. Resize observers and scheduled measurements are disposed
with the component. Revelation never scrolls an ancestor.

`BrowserView.pickMode` defaults to `ask`. `pin` keeps the pointing frame and picked ring but shows no question card and says “Click an element to point at it in your message”; the task browser uses it to stage picks as chat pins.
