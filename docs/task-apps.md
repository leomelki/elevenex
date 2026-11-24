# Task apps

Ask the agent to start a dev app in the current task, or to open an installed Android virtual device by name. An Apps panel shows the machine's live window. A local graphical task opens its native window by default. A remote task opens a stream. A caller can also select a private stream on a local Linux host.

The **Apps** tab appears while the selected task has a pending launch approval or an app that is starting, running, or stopping. When the last active run ends, the tab disappears and an open Apps panel switches to **Changes**.

The active conversation can reveal a newly requested app without moving keyboard focus. Its **Open app** link is scoped to the selected task. Click inside the picture, or Tab to it and press Enter, to interact. **Shift + Escape** returns the keyboard to Elevenex. Each run has a tab, like Browser tabs, and the same row offers actual size, a separate window, logs and stop for the selected run. Closing or detaching a viewer leaves the app running. **Reconnect** establishes a fresh viewer.

## Agent operations and permissions

- `start_app` accepts a display name, a caller-generated request UUID, and one of an executable with separate arguments, a saved `actionId`, or `androidAvd`. For example, launch `pnpm` with `["desktop:dev"]`. The backend resolves the working directory and machine from the authenticated coding session. Keep the request UUID when reconciling an interrupted launch. A Linux stream accepts an optional `virtualDisplay` with even pixel dimensions up to 1920 per axis and 2,073,600 total pixels. Its defaults are 1280×800 for desktop apps and 720×1280 for Android.
- A saved Action uses its task-owned command. Apps and Actions share one process, output, exit status and stop path. A changed Action requires a new approval.
- Codex and Claude sessions can launch directly when the active turn was admitted with full execution access. A constrained coding session prepares a request. The user sees the executable and argument boundaries in Apps and explicitly launches the process on the machine. Only the trusted desktop approval operation can promote that request. Plan mode cannot initiate launches. Requests expire after ten minutes.
- `list_apps`, `get_app` and `read_app_output` return task-scoped metadata and bounded recent output. Pass the last status as `afterStatus` to `get_app` to wait for a transition. `stop_app` stops the selected run. Display and input authority belong to desktop viewers.
- The task owns runs across conversation and viewer changes. Task finish and checkout release count starting and running apps and wait for cleanup before releasing the checkout. A pending request has no running process. An engine handoff checks for active apps even with every viewer disconnected. SQLite stores bounded launch receipts across engine restarts, including a fingerprint of the launch specification. The Apps log and approval details stay in engine memory. Saved Actions retain output under their existing persistence policy. A host reboot or backend shutdown ends runs. A new engine reconciles the old supervisor before releasing its checkout and never replays an interrupted launch.

## Host setup

| Host | Requirements and behavior |
| --- | --- |
| Linux | Python 3 at `/usr/bin/python3`, Xvfb, the XTEST extension, D-Bus and a working H.264 encoder. Run the backend as an ordinary user. The host creates a private X11 display, authorization cookie, runtime directories and session bus. Openbox or Fluxbox enables ordinary window placement and dialog management. X11-compatible apps work on headless hosts and on machines whose regular desktop uses Wayland. Native Wayland-only apps require an X11-compatible launch mode. |
| macOS | macOS 14 or later for the native capture helper, a logged-in and unlocked graphical session, and host Screen Recording permission. Input also requires Accessibility permission. The helper filters capture to an owned app window and targets input to its foreground process. The runtime includes the helper under `backend/bin/task-app-macos`. Follow the [Mac host instructions](../apps/backend/src/task-apps/native/macos/README.md) for permission setup and signing. |
| Windows | A logged-in and unlocked interactive account with Windows Graphics Capture and Direct3D support. Windows SSH uses a per-user limited Task Scheduler entry to reach that user's desktop. The signed-in account must match the SSH account. The helper tracks the owned process tree with a Job Object and selects its windows. Protected desktops, minimized windows, elevation boundaries, and applications that require global hardware input can limit capture or control. See the [SSH host guide](../apps/desktop/REMOTE_DEVELOPMENT.md). |
| Android Emulator | Install the SDK Emulator, a compatible system image and an AVD on the task machine. Set `ANDROID_HOME` or use the standard SDK path. Verify `emulator -list-avds` and `emulator -accel-check`. The adapter presents the emulator's native window, including its own device controls. It uses disposable writable data, a cold boot and a read-only AVD base. The emulator allocates its console/ADB port pair. GUI streaming does not require forwarding ADB or enabling an unauthenticated gRPC endpoint. |

The SSH installer requires a published archive matching the desktop revision, host OS and CPU architecture. New features become available when both desktop and backend contain the matching implementation. For nested Elevenex development runs, the launcher uses a run-specific profile, backend root and OS-assigned renderer port. Approved host binaries run as the host account. A task checkout and a private graphical session provide working-state isolation. Deploy mutually untrusted tenants under separate OS identities or VMs.

## Ownership and transport

The backend app host owns admission, launcher processes, display helpers, bounded output, input leases, and cleanup. Native helpers receive only the launch and presentation capabilities they need. Linux supervises orphaned descendants through a subreaper. macOS uses a process group and Windows uses a Job Object. Applications that delegate to an independently running instance may exit without producing an owned window. Launch them with a separate app profile when supported.

A viewer obtains a one-use, short-lived attachment ticket. The host authenticates both its issue and the WebSocket upgrade. The desktop keeps credentials in main and exposes named, scoped operations through preload. Windows authenticates the private named-pipe transport with TLS-PSK. SSH app operations carry an additional per-engine credential. Application processes receive a filtered environment. The viewer never receives an arbitrary network, OS-input or process-execution bridge.

The host delivers bounded baseline H.264 access units. Compatible viewers share a capture source, and each has an independent queue with cumulative paint receipts. A slow viewer resumes at a keyframe. The sandboxed renderer validates codec parameters and decoded dimensions before allocation, paints through WebCodecs and releases frames. One viewer controls each run at a time. Blur, disconnection and lease expiry release held input. Peers supporting binary app media send length-delimited bytes on the app channel and keep ordinary control messages on the existing JSON wire. Older peers use the existing byte tunnel. Both paths share SSH TCP congestion with other traffic.

Host implementations and limits live under [the host guide](../apps/backend/src/task-apps/README.md). See the [renderer guide](../apps/renderer/src/app/task-apps/README.md) for interaction tests and the [browser streaming design](task-browser-streaming.md) for the shared encoder infrastructure.

## Packaged Linux SSH smoke test

Run this opt-in test on Linux as an ordinary user whose account can authenticate
to a private OpenSSH server with a key. It requires the Linux graphical host
tools above, OpenSSH client and server, a working Electron sandbox, and the
native dependencies installed by the workspace. OpenSSH needs its standard
privilege-separation directory (`/run/sshd` on Debian and Ubuntu). Build both
sides from the same checkout:

```sh
pnpm backend:bundle
pnpm desktop:package --linux --dir
xvfb-run -a node scripts/test-task-app-ssh.mjs
xvfb-run -a node scripts/test-task-app-ssh.mjs --rtt-ms 20
xvfb-run -a node scripts/test-task-app-ssh.mjs --rtt-ms 80
```

You can omit `xvfb-run -a` in a graphical session. The fixture starts a private
loopback SSH server with temporary keys, a viewer profile, and a task database.
It stages the checkout-built backend in the SSH runtime cache so the smoke can
run without publishing a release archive. A restricted MCP session requests
a real Electron launch. The packaged desktop approves it through Apps, opens
a companion window, types into the streamed app, verifies the returned frames,
reattaches to the running app, and stops it. The optional delay applies to both
directions of the SSH connection. The runner reports input-to-frame measurements
and saves a PNG under `artifacts/task-apps/`.
