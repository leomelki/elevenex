# Optional terminal shell integration

The ordinary PTY is the foundation. Unsupported shells, opt-out and adapter
preparation failure all retain a usable terminal. Integration must not rewrite
output, repair prompt text, parse keystrokes into commands, or restart a process
because a hook did not initialize.

## Ownership

- `desktop-shell-integration.ts` prepares a launch plan and owns its private
  temporary files until the PTY manager invokes cleanup. It reads only the fixed
  shipped scripts. Failure returns an undecorated launch plan.
- `scripts/bashrc`, `scripts/zshenv` and `scripts/zshrc` own shell initialization
  and native shell hooks. User files are sourced without modifying them. No
  prompt/theme framework receives special treatment.
- `terminal-output-events.ts` parses bounded metadata in wire order, authenticates
  it and decodes a safe single-line command subset. It never executes commands or
  changes the output retained for xterm.
- `DesktopTerminalStream` owns output/geometry retention and process metadata.
  Rerun requires a reported command, a failed command and a clean ready prompt.
  Input only invalidates that permission; it is never retained as command text.
  Submission boundaries and further input conservatively disable rerun when
  buffered type-ahead could remain at the next prompt.
- `UserPtyManager` owns spawn, cancellation, the PTY and adapter cleanup. A launch
  is attempted once. Task/owner cleanup and generation fencing apply equally to
  integrated shells, plain shells and scripts.

The browser-facing contract has optional integration state and an optional
plain-shell capability. These are additive; older consumers keep the existing
terminal shapes and default launch semantics.

## Protocol and limitations

Adapters use OSC 133 framing with private authenticated extensions:
`B;token` (ready), `C;token` (started), `D;token;code` (completed),
`E;token;command` (command), and `X;token` (disabled). Frames accept BEL or ST
termination. Command backslashes and semicolons use the escaping convention
described by [VS Code shell integration](https://code.visualstudio.com/docs/terminal/shell-integration).
The token separates ordinary process output from our hooks; same-user programs
with filesystem/process access are outside that boundary.

Zsh preexec provides the submitted command directly. Bash has no equivalent
portable full-command callback. Its adapter accepts a command from history only
when the entry number advances exactly once since the previous ready prompt.
Ignored/duplicate/disabled history is never replaced by a guessed input line.
Existing DEBUG traps are not chained, evaluated or replaced. Bash without an
available start hook still reports completion. Rerun excludes commands over
4 KiB, controls and multiline input; ordinary terminal interaction is unaffected.

`ELEVENEX_TERMINAL_SHELL_INTEGRATION=0` disables injection in the backend
environment and disables hooks when set in a sourced user rc. The explicit
plain-shell create option bypasses preparation entirely. Pending state times out
only for display; it never kills or relaunches a slow shell.

## Assets and verification

Nest copies scripts beside the compiled user-terminal modules. The backend
bundle copies them to `shell-integration/scripts` beside `main.cjs`; local
desktop development, Electron staging and standalone remote staging all retain
that directory. They are immutable runtime assets, not files in the task checkout.

Real-PTY tests cover Bash 3.2, available modern Bash and zsh, history recall,
ignored history, password input, hook preservation, saved history and ordinary
shell fallback. Stream tests cover framing splits, malformed/foreign frames,
Unicode bounds, output geometry and generation gaps. Native renderer captures
cover the menu, focus restoration, plain-terminal typing and unavailable tracking.
