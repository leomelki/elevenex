# Task app host

A task owns each app run. A run can have several viewers and one keyboard and pointer owner. Closing the last viewer releases capture and encoding resources. The app can continue running in its checkout. The Apps panel and task teardown use the same stop operation.

## Launch and lifetime

The task service checks the checkout under its lifecycle lock. The host reserves a request ID before async setup and compares the complete launch specification on retries. Agent requests that need user authorization retain the proposed executable and arguments for up to ten minutes. Approval rechecks the initiating session and checkout. A saved Action uses the app supervisor as its process owner and publishes its bounded output and final status to the existing Action.

The launcher resolves the task's development toolchain through the same cached environment reader as the terminal. It passes an allowlist of toolchain and desktop variables to the child. Each launch receives a private scratch directory and a run ID. A program that keeps a singleton or persistent profile can use those values for a separate development instance. Elevenex desktop development uses them for its own nested instance.

The host keeps up to 128 current and recent runs with their names and bounded output in memory. SQLite journals the task and run IDs, hashed request identity and launch specification, creation time, mode, phase and supervisor creation identity. Terminal receipts remain eligible for pruning after 30 days. Admission is bounded to 1,024 retained receipts per task and 16,384 per host. A retry inside the retention window returns its original run ID, including after a crash.

The host commits the reservation before creating its supervisor. Each platform supervisor waits for a private stdin grant before starting the user program. The engine commits the supervisor's PID and OS creation identity before sending that grant. Losing the engine closes its control pipe and starts cleanup. The new engine expires pending approvals, reclaims ungranted reservations and observes any prior supervisor on demand. A matching or inaccessible process keeps the checkout reserved. On Linux and macOS the supervisor also acknowledges the empty child tree or process group before the engine removes its scratch directory. A forcibly killed POSIX supervisor can leave descendants, so a missing acknowledgement retains the checkout until a different OS boot proves those processes have ended. Windows closes the capture worker when the supervisor exits and queries the kill-on-close Job Object before releasing the checkout. The recovered receipt records the interruption. Recovery uses the stored identity only to observe process liveness. A fresh run requires a fresh request UUID. The Apps view offers retryable cleanup if the previous supervisor is still draining.

A managed runtime handoff seals new launches and stops every run, including disconnected and recovered ones, through the same stop operation. A run whose cleanup remains unconfirmed after 20 seconds keeps the current engine and reopens launches. Engine handoff is not process adoption: supervisors and capture channels belong to one engine, so an update ends running apps. Viewers reconnect to a running engine by reading the task's current run and opening a new presentation.

## Host adapters

| Host | Prerequisites and behavior |
| --- | --- |
| Linux | A normal user account, Python 3 at `/usr/bin/python3`, Xvfb with XTEST, a D-Bus session daemon, and an FFmpeg build with `x11grab` and the packet statistics pipe. A private X11 session works without a monitor, graphical login or GPU. Each stream gets its own Xauthority cookie, D-Bus address and XDG directories. An installed Openbox, Fluxbox, Xfwm4 or twm manages window placement. The fallback fits the first normal, resizable window to the private display, preserves fixed-size device windows, and focuses the clicked window. The run becomes ready after a visible window is mapped. Applications must support X11 for this adapter. |
| macOS | The managed native helper runs in a logged-in, unlocked graphical session. Screen Recording permits window capture. Accessibility permits input. The helper supervises the launch and owns the capture channel. Owned app windows and current geometry determine which surface accepts input. |
| Windows | The managed helper runs in the logged-in user's interactive session. Windows Graphics Capture requires Windows 10 version 1903 or later. Process creation atomically joins a Job Object. The viewer captures an owned window, sends pointer and keyboard messages to verified windows in that job, and releases input on disconnect. Applications using raw input or shortcuts that consult global keyboard state may handle targeted messages differently. System UI, an elevated application and the lock screen can require local interaction. |
| Android Emulator | Install the Android SDK Emulator and an AVD matching the host architecture. Verify hardware acceleration with the SDK's `emulator -accel-check`. Set `ANDROID_HOME` if the SDK is outside its standard location. The app run opens the emulator's native window with private writable data. On Linux the window runs inside its private display. |

A private X display isolates the presentation. Processes running as the same OS account share that account's filesystem and permissions. Place mutually untrusted workloads in separate OS accounts or VMs.

## Media and control

Linux captures the entire private display, including menus and dialogs. One FFmpeg process reads X11 pixels directly and produces bounded H.264 Annex B packets with packet lengths on a dedicated pipe. A viewer starts at an IDR. The host budgets viewers, probes encoders, and samples CPU quotas with the Browser runtime. A cold Linux viewer starts with software encoding. If a hardware probe succeeds, a fresh keyframe starts the hardware stream. Software remains available after hardware failure. Unchanged frames are suppressed, with periodic refresh for new viewers. Sustained congestion across viewers reduces bitrate and frame rate. Viewers can negotiate a frame header carrying encoded and logical display dimensions, so the host can also reduce Linux encoder resolution. A legacy viewer joining restores full resolution for that shared capture. Sustained recovery increases quality in steps.

On Windows the capture helper configures FFmpeg from the first complete frame at a stable window size and DPI. Later changes in size or DPI retire the active stream so a fresh attachment can use the new geometry. The helper moves BGRA pixels from D3D11 into an owner-restricted, local named pipe consumed by FFmpeg. It skips unchanged windows apart from periodic refresh. Only encoded video crosses JavaScript and the desktop bridge. macOS performs window capture and H.264 encoding in its native helper.

Each viewer has independent packet credit. The host uses recent send-to-paint receipt time to detect delayed delivery and bounds how many video bytes it commits to the reliable channel. A skipped packet requires keyframe recovery before delivering dependent packets. The host bounds pointer coordinates, serializes key and button events, and releases held inputs when the controlling viewer closes or expires. Input coordinates follow the logical display geometry.

## Verification

The general supervisor tests cover idempotency, pending approval expiry, close races and input validation. The journal suite reopens a real SQLite file. Its Linux crash case terminates the engine-side owner of a live supervisor and verifies child cleanup, a stable request receipt and worktree-release gating. A second test kills the POSIX supervisor before its final acknowledgement and checks that a same-boot retry keeps the checkout reserved. The host integration adds a real window, H.264 output, keyboard and pointer input, and cleanup of a child that detached its process group. Run the native scenarios from a host configured for that adapter.

```sh
ELEVENEX_TEST_APP_DISPLAY=1 ELEVENEX_TEST_ELECTRON_APP=1 pnpm --dir apps/backend exec jest --runInBand --runTestsByPath src/task-apps/task-app-host.spec.ts
```

Use `ELEVENEX_TEST_ELECTRON_APP=1` on a Windows or macOS graphical host with the managed helper under `ELEVENEX_BACKEND_RUNTIME_ROOT/bin`. The fixture launches the repository's installed Electron, waits for an encoded frame and checks the text received by a real renderer input. The Windows and macOS helper builds, desktop permissions, capture, and input require validation on their respective hosts.

On Windows, `node scripts/test-task-app-windows.cjs dist-runtime/elevenex-backend-windows-x64.tar.gz` extracts the native helper from a built portable runtime. It checks kernel job membership and probes for remaining job members after forcibly terminating the supervisor. With an unlocked interactive session it also decodes a live WinForms frame and verifies input delivery.
