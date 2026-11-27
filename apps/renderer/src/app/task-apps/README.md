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
a single centered state: a title, at most one short line, and the one action
that helps. Exited and failed runs offer **Show logs** there, beside what the
machine reported.
The machine name is omitted from the toolbar because the title island already
shows it.

Native runs present in their platform window. Streamed runs use a bounded H.264
viewer over the named preload operations. The surface fits the available space
by default. **Actual size** uses the logical display size and allows scrolling. Separate
windows connect independently.
Fitting is local to the viewer. When the host sends fewer encoded pixels under
network pressure, the visible canvas and input coordinates still follow the
logical display size.
Paint acknowledgments are cumulative, with one pending IPC call per viewer.
The viewer continues decoding while that call completes.
Video submission is also independent of paint completion: the shared decoder
can retain a frame until another packet arrives, including with
`optimizeForLatency`. The Apps viewer prefers software H.264 decoding when
WebCodecs supports it because hardware decoding can retain macOS interframes
beyond the viewer's queue window or while the captured window is idle.
The platform default provides a fallback when the software preference is
unavailable. The viewer and decoder each bound pending work to eight
packets and 3 MB. Decoder-local timestamps match outputs to their packets;
reset rejects pending outputs and closes late frames. Receipts still acknowledge
only painted frames and can cover older decoded frames when outputs arrive together. Local decoding/drawing failures are distinguished from
missing packets and slow transport in recovery guidance.

`scripts/desktop-capture/scenarios/task-apps-native-video.mjs` exercises a
VideoToolbox keyframe and interframes through the production viewer. It checks
paint receipts, pixels during motion and idle, refresh after a pause, and
decode-failure guidance in both themes. The versioned preview fixture was
captured from a disposable AppKit window displaying solid colors. Each access
unit retains the native helper's nine-byte header.

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

When an agent needs the user to launch a proposed command, the panel shows one
request screen: the app name, the machine for a remote host, and the command
as one line. Arguments that are empty or contain anything beyond plain path
and flag characters are JSON-quoted, so argument boundaries stay unambiguous.
Bidirectional and zero-width characters are shown as escapes. **Launch**
accepts that run. **Decline** dismisses it. Viewing the request never starts a
process.

When a run reports a host prerequisite, `TaskAppSetupComponent` shows a compact
card: the "Needs you" glyph, a title, one line saying what the host found, and
two or three numbered steps. A step that the host can open carries its own
**Open** button, scoped to the run. A remote card says that someone at the
machine has to do this only for permissions and sign-in. Remote cards also
offer **Copy steps** for the local clipboard. In a request, the card sits
between the command and the decision, so the command is never hidden. A failed
run shows the card centered with **Dismiss**. Beside a live picture it becomes
a strip above the video. The Accessibility guide keeps the video attached while
input is unavailable.

**Launch** shows **Checking…** for a setup-blocked request and **Launching…**
otherwise. It stays disabled until a status read started after the reply
reconciles the run. A successful HTTP response can still mean that host setup
blocked the launch. The card then says **Still blocked** with the host's
current guide. An older in-flight read cannot consume that result. Changing
tasks/runs discards the pending feedback, and no launch replays automatically.

Mac permission guides fold their fallback behind **Elevenex Agent isn't in the
list?**: **Show in Finder** on the host, followed by the installed helper path
and **Copy app path** for the settings file picker. The host derives this path
from its own managed runtime. Replies and copied-path feedback are discarded
when the selected run or setup issue changes.

Fresh host launch events can reveal Apps for the selected conversation in the
focused, visible workspace. The first revision after navigating or regaining
focus establishes a baseline and never replays earlier launch events.

A chat link in the form `[Open app](elevenex-app:<run UUID>)` opens a run from
the selected task while it has active apps. This link is handled as a local UI
intent and carries no URL, credential or launch command. Unknown run IDs show
an unavailable state if the task has active apps.
## Errors, alerts and recovery

`app-recovery.ts` words every failure the panel can show. It only describes a
situation and never decides what happens. Each message is a short title and
one short line: what happened, the machine when it is remote, and the next
step that really is available. Leave out what the buttons already say and
reassurances that nothing else changed unless the person might fear it did.
Primary copy never repeats internal text. The adapter's code, HTTP status and
message sit behind a **Details** disclosure. A run's own `detail` is shown in
mono as what the machine reported.

- **Reads** (run list, logs) are safe to repeat, so failures offer **Try again**.
  A failed run read stops polling until then. A missing named operation says
  that this version of Elevenex needs an update instead of failing silently.
- **Mutations** (launch, decline, stop, open setup, show agent in Finder) can
  come back as an unknown outcome. The wording says the host may have acted,
  that status is being refreshed, and when repeating is reasonable. Nothing
  replays on its own. The alert is tied to the run's status at failure time and
  disappears once the refresh shows that status has moved on.
- **Open setup** and **Show agent in Finder** claim only that the host was
  asked. The panel cannot see the host's screen, so the copy says to look there.
- **Setup cards** begin with what the host found, then steps phrased for the
  host (`this Mac` locally, the machine's name remotely). Guides marked
  `inPerson` (permissions and sign-in) tell a remote viewer that someone at
  the machine has to do them. `macos-desktop-connection` states that
  permissions alone do not establish the agent's desktop connection and ends
  with reconnecting/updating the engine.
- **Displays** map the host's known ending reasons and the desktop's refusal
  codes to a title, a cause and **Reconnect**. An unknown host reason is shown
  verbatim. Input failures match `APP_INPUT_GUIDANCE` by suffix because Electron
  prefixes IPC errors. A focus failure offers a retry in the preview first.
  Window changes and transient interruptions of a previously working viewer
  get up to three fresh attachments. Input stays released until the viewer has
  painted a new frame and the user takes control again. An intentional sharing
  stop leaves **Reconnect** as the explicit action.

  Host capture/encoding failure (stream close code 4004) keeps the app running
  and explains that the picture could not be prepared, with resize/reconnect
  and engine-update recovery. It is distinct from transport loss and optional
  Accessibility input permission.

Preview and capture the states with `/task-apps` and the fixture's failure
fields (`readFailure`, `logsFailure`, `watchRefusal`, `actionFailure`,
`inputGuidance`).

Preview the production renderer on `/task-apps`. The native capture scenario
`scripts/desktop-capture/scenarios/task-apps.mjs` supplies encoded video and
checks focus, pointer, keyboard, release, retry, stale-view rejection and logs.
