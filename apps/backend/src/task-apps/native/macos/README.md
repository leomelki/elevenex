# macOS task app host

The managed backend ships `bin/task-app-macos` for macOS 14 or later. Run the following from the installed backend directory **on the task Mac**, as the account signed in to its graphical session, to open the system permission prompts.

```sh
./bin/task-app-macos --authorize
./bin/task-app-macos --check
```

Allow Screen Recording for the installed helper to stream an app. Accessibility allows input. If macOS attributes a terminal prompt to the terminal application, add the installed helper executable under **System Settings → Privacy & Security → Screen & System Audio Recording** and **Accessibility**, then retry from the connected desktop. The streamed launch checks permission in its actual graphical launch context. A viewer can watch an owned window while another application has focus. Input requires the captured app to be foreground. Locking the Mac, switching users, replacing the active window, or resizing it ends the current stream. The task app keeps running and a new attachment discovers its current window and geometry. A system-owned dialog may require a person at the task Mac. Native launches require no capture permissions.

The supervisor waits on stdin for the backend's durable launch receipt before creating user processes. EOF before that receipt cancels the launch. It creates a fresh process group with `posix_spawn` before the launched program can fork. It reports the new group on fd 3. The backend owns stdin and the private duplex fd 4. Both descriptors are closed in the launched app, which inherits a null stdin and normal stdout and stderr. Losing the backend closes stdin. The supervisor drains its group, including children still running after the original launcher exits. An app deliberately moving a descendant to another session or group falls outside this ownership mechanism.

The capture helper accepts only the group it created. ScreenCaptureKit filters one visible top-level window from that group. VideoToolbox consumes native pixel buffers and sends bounded Annex B H.264 access units. A single encoder serves the run's viewers and releases its capture when the last viewer leaves. Input uses Quartz events posted to the verified foreground PID. The adapter rechecks the front window, screen authority, and dimensions before sending input. macOS secure surfaces, the global menu bar and unrelated applications have no input route.

Desktop main obtains a short-lived ticket before attaching to the scope-bound App stream. A close or reconnect creates a fresh viewer identity. The process-level input lease releases held keys and buttons when a controlling viewer disconnects.

Run `node scripts/test-task-app-macos.cjs` from a checkout on a Mac with Xcode Command Line Tools. It compiles and signs the native helper, verifies the code signature, checks a synthetic VideoToolbox keyframe and exercises process-group cleanup. After building the backend TypeScript and granting the installed helper its permissions, run the interactive check from the checkout. It opens a disposable AppKit window on the task Mac, receives its actual ScreenCaptureKit keyframe, and verifies the app received a mouse click and a key press. Leave the fixture in the foreground during the check.

```sh
node scripts/test-task-app-macos.cjs --interactive /path/to/installed/backend/bin/task-app-macos
```

Keyboard layout, system dialogs, and multiple displays need separate graphical testing. For release signing, set `ELEVENEX_APP_DISPLAY_SIGN_IDENTITY` to an installed Developer ID Application identity before building the backend archive. Development builds use an ad hoc signature. macOS can require fresh permission after an ad hoc binary changes.

The implementation uses [ScreenCaptureKit window filters](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:)), [VideoToolbox H.264 encoding](https://developer.apple.com/documentation/videotoolbox/vtcompressionsession) and [process-targeted Quartz events](https://developer.apple.com/documentation/coregraphics/cgevent/posttopid(_:)).
