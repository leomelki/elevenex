# Task apps

The Apps panel shows runs for the selected task. The backend owns each launch and
its output. Closing the panel or its companion detaches the viewer. **Stop app**
ends the run. Native runs present in their platform window. Streamed runs use a
bounded H.264 viewer over the named preload operations. **Fit** scales the
surface to the available space. **Actual size** preserves pixels and allows
scrolling. Separate windows connect independently.

Click the surface or use **Focus app** to send pointer and keyboard input. Use
**Shift + Escape** or **Release keyboard** to return to the viewer controls.
UI controls and bounded text logs are accessible to assistive technology. The
video surface carries pixels and has no remote accessibility tree.

The task and scope select metadata, the run selects a process, and a fresh UUID
selects each viewer attachment. Readers reject obsolete replies and frames.
Blur releases input. Hiding or destroying the surface drops the watch and
clears its pixels. Reconnecting a stream requests a new keyframe. Read polls run
only in the visible view and stop on a transport error. A stop with an unknown
outcome refreshes metadata before the user can choose another action.

When an agent needs the user to launch a proposed command, the panel displays
the executable and individual arguments. **Launch on machine** accepts that
run. **Cancel** dismisses it. Viewing the request never starts a process.

Fresh host launch events can reveal Apps for the selected conversation in the
focused, visible workspace. The first revision after navigating or regaining
focus establishes a baseline and never replays earlier launch events.

A chat link in the form `[Open app](elevenex-app:<run UUID>)` opens a run from
the selected task. This link is handled as a local UI intent and carries no URL,
credential or launch command. Unknown run IDs show an unavailable state.
Preview the production renderer on `/task-apps`. The native capture scenario
`scripts/desktop-capture/scenarios/task-apps.mjs` supplies encoded video and
checks focus, pointer, keyboard, release, retry, stale-view rejection and logs.
