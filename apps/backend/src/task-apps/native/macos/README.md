# macOS task app host

The managed macOS 14+ runtime ships **Elevenex Agent.app** under `bin/`.
The app bundle contains both the setup UI and the capture executable. Public
Developer ID builds retain the bundle identifier `com.elevenex.task-app-display`
and display name **Elevenex Agent**. Runtime archives contain only regular files and
directories, so callers launch `Contents/MacOS/Elevenex Agent` inside the bundle;
there is no `bin/task-app-macos` alias.

Apps opens setup with LaunchServices, so the floating card can appear in the
host's desktop even when SSH cannot join its audit session directly. The card
opens Screen Recording or Accessibility settings and provides a draggable
file URL for its own signed bundle. It never manipulates System Settings or
grants permission itself. Screen Recording is required for viewing.
Accessibility is optional and enables input. A copy-path alternative works
with the permission pane's **+ → ⌘⇧G** file picker.

Opening setup always requests a new instance of the exact runtime bundle.
LaunchServices may otherwise reactivate an older runtime with the same bundle
identifier, and macOS's **Quit and Reopen** can leave its old setup card visible
against the current build's grant. The new setup closes previous regular setup
applications for the same identifier and user. Capture, supervisor and probe
instances remain accessory/background applications and are preserved. The
Accessibility step says that viewing is already ready and offers Skip.

Ad hoc development builds use `com.elevenex.task-app-display.development.<hash>`
and the visible name **Elevenex Dev <short hash>**. The hash covers the built
native executable and bundled resources, before applying the development name.
Identical helpers in different backend revisions retain the same bundle ID and
code signing requirement. A changed helper gets a new identity and requires a
new grant. This separates incompatible ad hoc code identities so System Settings
cannot reopen an older, differently granted helper through a shared bundle ID.
It also keeps development grants separate from public releases. The setup tile,
manual instructions, Accessibility reset and capture all use that build's identity.
There is no automatic grant migration or privacy database modification.

The draggable tile shows only the app icon and a dashed arrow running off the
tile edge toward the System Settings window, which the panel docks beside. It
deliberately draws no destination: a drop zone inside the panel would invite
drops that cannot work. Only the icon's half is the grab handle (open-hand
cursor, lifts on hover). Until the first drag, a faded copy of the icon
periodically glides out along the arrow; reduced motion keeps it static. Two
numbered steps below the tile name the destination list and the switch to turn
on, followed by a live checking status. A drag that moves but is accepted
nowhere briefly replaces the status with where to release it.
**Use + instead** switches to the keyboard alternative with a selectable,
middle-truncated app path. Escape returns to dragging, Command-W closes setup,
and Return on the draggable app opens the alternative and copies its path.
Skipping Accessibility opens a viewing-only summary with an option to resume
input setup. Completion summarizes both grants and gives **Done** the default
button treatment. It still asks the connected viewer to **Check and launch**.

While Accessibility is off, **Already enabled?** opens recovery guidance.
**Reset Accessibility** explicitly clears only `com.elevenex.task-app-display`’s
Accessibility decision through `/usr/bin/tccutil`, with separate, fixed arguments.
It never resets Screen Recording, another application, or all permissions, and
never grants access. The user then adds and enables the current signed bundle
in System Settings. A failed reset shows the native **−**, add and enable steps.
The task factory supplied by the CLI is the privileged process boundary; setup
owns its asynchronous execution, five-second timeout and cancellation on close
or reopen. The UI disables repeat actions during the reset, resumes fresh
permission polling afterward, and never treats a successful reset as a grant.

`Setup.m` owns the setup flow, permission checks, window placement and cleanup.
`SetupViews.m` owns the draggable item, progress, themed wells and controls.
The build derives `AgentTheme.json` from the authoritative design tokens,
so the signed bundle carries the light/dark colors it needs without loading
checkout files at runtime. Focus remains visible during keyboard navigation;
mouse use does not leave a permanent outline around the draggable item.

A fresh, bounded child of the setup app checks Screen Recording, shareable-content
availability and Accessibility. The setup card uses those results, never drag
completion, for its status. Polling stops on close or after ten minutes. The
completed card discards its cached grants and checks again when reopened. The
remote viewer's **Check and launch** still validates the real capture host.
The UI's permission status alone does not prove an SSH engine can connect to
the desktop. The signed-in account must match the SSH account.

The backend's **Check and launch** probe and streamed capture also run through
LaunchServices. A direct SSH spawn, including `launchctl asuser`, can retain
SSH's TCC responsibility even when it can see the desktop. It can therefore
report Screen Recording denied after setup correctly reports the agent's grant.
`DesktopConnection.m` creates a private, short-lived Unix rendezvous in a 0700
directory. Both peers require the same effective UID and canonical native agent
executable, checked with kernel peer credentials/PIDs. A bounded request carries
only a check or the supervisor's freshly minted group; `SCM_RIGHTS` transfers
only its existing private display descriptor. This entry accepts neither a
launch command nor a caller-supplied capture target from an untrusted process.
The supported symlink CLI is resolved to the real bundle before opening it.

The original supervisor keeps the user process, environment, cwd, stdio,
durable launch gate and filesystem authority. Only capture and input execute
in the LaunchServices instance. `Capture.m` owns that instance's window filter,
encoder, control reader and lifetime. Closing its authenticated owner connection
ends the helper; losing the helper drains the original supervisor's group.
Window change detection compares WindowServer frames with their original
WindowServer measurement. ScreenCaptureKit can omit the window border, so its
picture bounds are kept separately for capture sizing and input coordinates.
Moving a window preserves that inset; resizing still requires a fresh stream.
Capture initially selects the largest visible owned layer-zero window, then
validates that specific window's visibility, ownership and size. A separate
native control window (including AppKit's 66×20 title-bar controls) or another
overlapping window must not continually restart the stream. Desktop-independent
capture does not require moving unrelated apps out of the way. Input requires
the selected window's original process to be foreground. A primary click on
the picture can request activation of that verified process. When activation
is needed, the first click only requests focus. Click again to interact. If
macOS declines the request, bring the window to the front on the task Mac.
The helper tolerates the 66×20 macOS sharing control at the upper-left of
that same owner's captured window. Other same-process title-bar controls and
separate same-process windows allow input when the Accessibility focused
window matches the captured WindowServer frame. Pointer input excludes the
actual title-bar overlap. An owned dialog over the content or a different
focused window blocks control with its own viewer message while the picture
stays visible. Dismiss the dialog on the host to resume control. Clicks, drags
and scrolls carry the verified window number and a position in that window so
AppKit can dispatch them.
The supervisor registers the private rendezvous before starting its monitor,
so even a fast-exiting app cleans it up. No persistent launch agent, additional
OS-wide grant, or reset of SSH permissions is required. The legacy `--launch`
entry retains its in-process capture; managed streams use `--launch-desktop`.

Capture sizing keeps both axis limits (1920×1440) and a 1920×1080 pixel budget,
with even dimensions and preserved aspect ratio. The advertised H.264 Baseline
4.2 profile cannot encode the old 1920×1278/1440 output from common Retina
windows. Native codec regression checks encode real keyframes at production
sizes, including a 1440×959 window, portrait windows and 4K source geometry.
Capture/encoding failure has its own stream close code (4004), so the viewer
shows a picture preparation error rather than reporting a network disconnect.

Both development and release archives include the app's complete resources,
icon and executable. Public runtime CI imports the configured Developer ID
certificate, signs with hardened runtime, notarizes and staples the app,
then verifies the extracted archive through Gatekeeper. Missing release
signing credentials fail the build. Verification checks that the plist and signed
identifiers agree; public builds additionally require an Apple Developer ID
certificate and reject a hash-pinned designated requirement. Keep the same
Developer ID team and public bundle ID across updates so macOS can recognize
the new version's privacy identity. See Apple's
[code signing requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).
Setup writes no mutable state into the signed bundle.
Local certificate signing also requires Developer ID Application; Apple
Development or self-signed code cannot share the public permission identity.

Persistent content capture is opt-in and disabled by default. Apple's
[Persistent Content Capture entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)
requires approval for the agent's App ID, `com.elevenex.task-app-display`.
After approval, generate a Developer ID provisioning profile for that App ID
and the release signing certificate with the entitlement enabled. For local
release builds, set `ELEVENEX_APP_DISPLAY_PERSISTENT_CAPTURE_PROFILE` to the
profile's path alongside the existing signing and notarization settings.
For public runtime CI, add its base64-encoded contents as the optional
`APPLE_APP_DISPLAY_PROFILE_BASE64` repository secret. An absent secret keeps
the current capture and signing behavior; do not set it before approval.
CI then requires the signed capture entitlement and embedded profile to survive
archive extraction, using `scripts/verify-task-app-macos.cjs` with
`--require-persistent-capture` alongside the existing notarization check.

`scripts/task-app-macos-signing.cjs` checks that the supplied profile authorizes
capture for the agent, allows distribution and has not expired. The build embeds
it at `Contents/embedded.provisionprofile` before signing and claims only
`com.apple.developer.persistent-content-capture`, `com.apple.application-identifier`
and `com.apple.developer.team-identifier`. Other capabilities in the profile are
not copied. Ad hoc signing and invalid profiles fail the build rather than
silently dropping the requested entitlement. macOS and Gatekeeper still validate
Apple's authorization and the profile's match to the signing certificate; these
build checks do not replace that validation. See Apple's
[provisioning profile guidance](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles).

This entitlement supports persistent capture; it does not grant Screen Recording
or Accessibility permission. Keep the host setup and window/input confinement.
Run `node --test scripts/task-app-macos-signing.test.cjs` for signing regressions.
The native tests use unsigned CMS fixtures and inspect signed claims without
launching them. Real entitlement authorization and prompt behavior require an
approved profile, its Developer ID certificate and a notarized build on a Mac.

An older ad hoc build's Accessibility entry can remain enabled while its code
requirement no longer matches the current binary. Repeated checks or dropping
the updated bundle again cannot reliably replace that entry. The recovery flow
supports this case without a shell. Keep the same Developer ID signing identity
and bundle identifier across public releases; do not weaken the [designated code
requirement](https://developer.apple.com/documentation/security/applying-code-requirements)
to make ad hoc builds inherit another binary’s permission.

Run `node --test scripts/task-app-macos-update.test.cjs` for real native rebuild
and signing requirement checks across unrelated backend updates and changed
helper code. On a signed-in Mac, set `ELEVENEX_TEST_MAC_AGENT_REOPEN=1` for the
additional LaunchServices reopen test with isolated fixture apps. It alternates
old/new bundle-ID launches without granting privacy permissions. This checks
routing, not System Settings automation or preservation of a real user's grant.
The latter requires two Developer ID releases and a manually granted test account.

The supervisor waits on stdin for the backend's durable launch receipt before creating user processes. EOF before that receipt cancels the launch. It creates a fresh process group with `posix_spawn` before the launched program can fork. It reports the new group on fd 3. The backend owns stdin and the private duplex fd 4. Both descriptors are closed in the launched app, which inherits a null stdin and normal stdout and stderr. Losing the backend closes stdin. The supervisor drains its group, including children still running after the original launcher exits. An app deliberately moving a descendant to another session or group falls outside this ownership mechanism.

The capture helper accepts only the group it created. ScreenCaptureKit filters one visible top-level window from that group. VideoToolbox consumes native pixel buffers and sends bounded Annex B H.264 access units. A single encoder serves the run's viewers and releases its capture when the last viewer leaves. Input uses Quartz events posted to the verified foreground PID. The adapter rechecks the front window, screen authority, and dimensions before sending input. macOS secure surfaces, the global menu bar and unrelated applications have no input route.

Desktop main obtains a short-lived ticket before attaching to the scope-bound App stream. A close or reconnect creates a fresh viewer identity. The process-level input lease releases held keys and buttons when a controlling viewer disconnects.

Run `node scripts/test-task-app-macos.cjs` from a checkout on a Mac with Xcode Command Line Tools. It compiles and signs the native helper, verifies the code signature, checks a synthetic VideoToolbox keyframe and exercises process-group cleanup. After building the backend TypeScript and granting the installed helper its permissions, run the interactive check from the checkout. It opens disposable AppKit windows on the task Mac and receives real ScreenCaptureKit frames. It checks clicks, drags, scrolling, keys, Unicode text, dialog blocking, and click-to-focus recovery after the second app takes focus. Leave focus switching to the fixtures during the check.

On a signed-in Mac, `node scripts/test-task-app-macos.cjs --window-geometry`
also checks real WindowServer selection with a simulated picture inset, window
movement, resizing, title-bar control geometry, separate and covering windows,
and ownership rejection. The fixture reads its own Accessibility focus without
a capture or input grant. The interactive check requires the actual
stream to keep delivering frames across several window-monitor ticks before
testing input; receiving just its first keyframe does not establish stability.

```sh
node scripts/test-task-app-macos.cjs --interactive "/path/to/installed/backend/bin/Elevenex Agent.app/Contents/MacOS/Elevenex Agent"
```

Use `--capture-only` with the same installed helper path to verify sustained
real ScreenCaptureKit video without an Accessibility grant or input injection.
It still requires Screen Recording and a signed-in, unlocked graphical session.

Keyboard layout, system dialogs, and multiple displays need separate graphical testing. For local release validation, set `ELEVENEX_APP_DISPLAY_SIGN_IDENTITY`, `ELEVENEX_APP_DISPLAY_KEYCHAIN` and `ELEVENEX_APP_DISPLAY_NOTARY_PROFILE`. Set `ELEVENEX_APP_DISPLAY_REQUIRE_SIGNING=1` to enforce both signing and notarization, as public CI does.

The implementation uses [ScreenCaptureKit window filters](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:)), [VideoToolbox H.264 encoding](https://developer.apple.com/documentation/videotoolbox/vtcompressionsession) and [process-targeted Quartz events](https://developer.apple.com/documentation/coregraphics/cgevent/posttopid(_:)).

If LaunchServices cannot establish the private connection, Apps reports
`macos-desktop-connection`, separately from missing Screen Recording or a locked
session. The user can reconnect/update the engine and retry. A successful
permission grant alone does not establish that the private connection works.

On a signed-in Mac, `node scripts/test-task-app-macos.cjs --desktop-connection`
uses a separately identified fixture app without granting any permissions.
It exercises real LaunchServices, the preflight result, the durable launch gate,
rejection of an unrelated peer and arbitrary capture groups, bidirectional
display receipts, cwd/environment/argv/stdio preservation, exit codes and group
cleanup. Actual authorized ScreenCaptureKit frames and input still require the
interactive test with the installed, granted agent.

For isolated native UI previews (with fixture permission states and no grants),
run `node scripts/test-task-app-macos.cjs --setup-preview artifacts/task-app-agent/native-preview`.
This exercises the production AppKit views in light, dark, Accessibility and
enabled states. A separate LaunchServices smoke on a signed-in Mac is needed
to verify a real host window. Neither UI previews nor an ad hoc build verify
a public Developer ID release's notarization or the user's permission grant.
Recovery scenarios use disposable processes instead of `tccutil`; they cover
explicit user intent, focus, busy controls, success without a grant, failure,
launch failure, timeout, retry, a subsequent verified grant and close cleanup.
They never clear the real agent’s permissions.
