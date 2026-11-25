# Task apps

The workspace shows the Apps tab when the selected task has a launch request
or a starting, running, or stopping app. Apps selection follows the task across
conversation switches. The workspace remembers recent tasks' Apps selections and
reuses recent run metadata from the same backend scope while a new read is pending.
A selected Apps tab stays visible during that read. When the current read confirms
there are no active runs, Apps returns to Changes. The backend owns each launch
and its output. Closing the panel or its companion detaches the viewer.

The panel has one header row. Each run is a tab in the shared side-view strip
(`ViewTabs` without New or close): a steady dot marks a running app, a spinner
one that is starting or stopping, and a failure glyph a failed launch. The
selected run's icon actions sit at the right of the same row. A separate window
shows only its own run's tab.
Streamed runs offer **Actual size** and **Open in a separate window**; every
launched run offers **Logs**, which folds bounded output in under the app, and
active runs offer **Stop app**. The rest of the panel belongs to the app or to
a single centered state. Exited and failed runs also offer **Show logs** there.
The machine name is omitted from the toolbar because the title island already
shows it.

Native runs present in their platform window. Streamed runs use a bounded H.264
viewer over the named preload operations. The surface fits the available space
by default. **Actual size** preserves pixels and allows scrolling. Separate
windows connect independently.
Fitting is local to the viewer and leaves the host capture size unchanged.
Paint acknowledgments are cumulative, with one pending IPC call per viewer.
The viewer continues decoding while that call completes.

Click the surface to send pointer and keyboard input. Keyboard users Tab to the
surface and press **Enter**. **Shift + Escape** returns focus to the surface
without capturing input again. A small hint over the corner of the surface
shows how to release control or, with keyboard focus, how to take it, and it
never intercepts the pointer. UI controls and bounded text logs are accessible
to assistive technology. The video surface carries pixels and has no remote
accessibility tree.

The task and scope select metadata, the run selects a process, and a fresh UUID
selects each viewer attachment. Readers reject obsolete replies and frames.
Blur releases input. Hiding or destroying the surface drops the watch and
clears its pixels. Reconnecting a stream requests a new keyframe. The open
workspace side panel polls bounded run metadata while its window is visible.
Video and log polling require the Apps view. Reads stop on a transport error.
A stop with an unknown
outcome refreshes metadata before the user can choose another action.

When an agent needs the user to launch a proposed command, the panel displays
the executable and individual arguments. **Launch** accepts that
run. **Decline** dismisses it. Viewing the request never starts a process.

When a run reports a host prerequisite, the same panel shows its setup steps
and the machine that needs them. The open-settings intent is scoped to the
run and opens the macOS pane on the host. Copy instructions uses the local
clipboard. The reviewed command remains available and **Check and launch**
rechecks the original request. The Accessibility guide leaves video attached
while input is unavailable.

Fresh host launch events can reveal Apps for the selected conversation in the
focused, visible workspace. The first revision after navigating or regaining
focus establishes a baseline and never replays earlier launch events.

A chat link in the form `[Open app](elevenex-app:<run UUID>)` opens a run from
the selected task while it has active apps. This link is handled as a local UI
intent and carries no URL, credential or launch command. Unknown run IDs show
an unavailable state if the task has active apps.
Preview the production renderer on `/task-apps`. The native capture scenario
`scripts/desktop-capture/scenarios/task-apps.mjs` supplies encoded video and
checks focus, pointer, keyboard, release, retry, stale-view rejection and logs.
