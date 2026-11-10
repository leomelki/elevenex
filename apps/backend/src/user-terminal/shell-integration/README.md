# Optional terminal shell integration

The ordinary PTY is the foundation. Unsupported shells, opt-out and adapter
preparation failure all retain a usable terminal. Integration must not rewrite
output, repair prompt text, parse keystrokes into commands, or restart a process
because a hook did not initialize.

## Ownership

- `desktop-shell-integration.ts` prepares a launch plan and owns its private
  temporary files until the PTY manager invokes cleanup. It reads only the fixed
  shipped scripts. Failure returns an undecorated launch plan.
- `scripts/bashrc`, `scripts/zshenv`, `scripts/zshrc`, `scripts/integration.fish`
  and `scripts/integration.ps1` own shell initialization
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
`E;token;command` (exact command), `H;token;command` (history-derived command),
`P;token;directory` (observed cwd), and `X;token` (disabled). Frames accept BEL or ST
termination. Command backslashes and semicolons use the escaping convention
described by [VS Code shell integration](https://code.visualstudio.com/docs/terminal/shell-integration).
The token separates ordinary process output from our hooks; same-user programs
with filesystem/process access are outside that boundary.

Zsh preexec and fish preexec events provide the submitted command directly.
PowerShell wraps the existing PSConsoleHostReadLine function after profiles load;
without it, only new Get-History entries are reported at completion. The original
prompt/readline functions, PSReadLine options, key bindings and history filters
remain in charge. Restricted language mode disables integration; execution policy
is never bypassed. PowerShell reports pipeline success as 0/1, since LASTEXITCODE
can be stale after non-native commands. Non-filesystem providers report an unknown
cwd rather than a filesystem path.

Fish uses --init-command after its normal startup configuration and native
fish_preexec/fish_postexec/fish_prompt events; it does not replace fish_prompt.
Neither adapter scans program input or user history files.

Zsh preexec provides the submitted command directly. Bash has no equivalent
portable full-command callback. Its adapter accepts a command from history only
when the entry number advances exactly once since the previous ready prompt.
It reports before execution where the native start hook permits, and reconciles
metadata at completion.
Ignored/duplicate/disabled history is never replaced by a guessed input line.
Existing DEBUG traps are not chained, evaluated or replaced. Bash without an
available start hook still reports completion. Rerun excludes commands over
4 KiB, controls and multiline input; ordinary terminal interaction is unaffected.

`ELEVENEX_TERMINAL_SHELL_INTEGRATION=0` disables injection in the backend
environment and disables hooks when set in a sourced user rc. The explicit
plain-shell create option bypasses preparation entirely. Pending state times out
only for display; it never kills or relaunches a slow shell.

Prompt-ready markers belong at the end of the rendered prompt, not merely in a
pre-prompt hook. Bash/zsh append a nonprinting marker after user prompt hooks;
fish wraps its existing prompt, and PowerShell appends after its prompt text.
A missing/unsupported prompt wrapper may reduce metadata/prediction but never
blocks PTY input. Editing-key prediction is optional and still requires a confirmed
echo in each prompt epoch. A prompt grant is not a guarantee about arbitrary
user-defined shell widgets or echo policy.

## Command metadata and navigation

`TerminalCommandTracker` owns one running record and immutable completed records,
independently of terminal scrollback. It retains at most 200 records and 128 Ki
UTF-16 text units; reads return at most 20 completions plus the current record.
The generation and after-ID cursor detect replacements and expiration. Records
include bounded command text, exact/history/unavailable confidence, cwd at start,
receipt timestamps, monotonic elapsed duration, output offsets and exit state.
Missing start hooks yield null start/duration rather than fabricated timing.
Process exit or disabled integration finalizes a running record as interrupted;
startup/empty prompts do not fabricate executions. Metadata lives only with the
process and is not persisted or added to ordinary list/output snapshots.

The named taskTerminalCommands bridge validates identities, cursors, record
ordering, shapes and bounds in main. It has no mutation/rerun action. Output pages
carry at most 201 authenticated command-start offsets within that page. The
renderer splits writes at these offsets and owns bounded xterm markers, which
follow buffer reflow and expire with scrollback. Command/Ctrl-Up/Down navigates
those markers without sending input; raw OSC output cannot authorize a marker.
Reset, process-generation gaps and surface disposal release the markers.

`cwd` in existing terminal metadata remains the launch workspace. Optional
`currentCwd` supplies observed directory changes; the renderer falls back to the
launch workspace when unknown. These paths are display metadata, never resource
permissions or execution directories. Multiline commands can be retained for
display (newline/tab escaping), but remain ineligible for rerun.

## Activity titles

`terminal-title.ts` normalizes bounded display hints and extracts only a leading
literal executable name from a reported command, excluding arguments. It is not
a shell parser or foreground-process probe; unsupported heads retain the saved
name. The stream derives title lifetime from its existing `tracking.current`
record. Standard OSC 0/2 titles are associated with that command ID, so neither
prompt titles nor previous commands can leak into the next execution. Completion
and process exit restore the saved label; plain terminals may report standard
titles independently of shell integration.

These unauthenticated titles are display hints only. They do not change command
records, rerun eligibility, service hints or navigation boundaries. Controls and
directional overrides are stripped, raw input is capped at 1,024 code units and
displayed titles at 120 without splitting surrogate pairs. Service replies retain
`title` and add optional `activityTitle`; saved names differing from the shell
basename and project-script names always take priority. No persisted name or
legacy protocol changes, process table polling or additional IPC channel is needed.

## Assets and verification

Nest copies scripts beside the compiled user-terminal modules. The backend
bundle copies them to `shell-integration/scripts` beside `main.cjs`; local
desktop development, Electron staging and standalone remote staging all retain
that directory. They are immutable runtime assets, not files in the task checkout.

Real-PTY tests cover Bash 3.2, available modern Bash and zsh, history recall,
ignored history, password input, hook preservation, saved history and ordinary
shell fallback. Stream tests cover framing splits, malformed/foreign frames,
Unicode bounds, output geometry and generation gaps. Native renderer captures
cover the menu, focus restoration, plain-terminal typing, unavailable tracking
and authenticated command navigation in both themes. Additional real-PTY
fish/PowerShell regressions run when those executables are installed; they are
explicitly skipped on this Mac. Adapter preparation/cleanup tests cover all four
shell families without requiring those optional executables.
