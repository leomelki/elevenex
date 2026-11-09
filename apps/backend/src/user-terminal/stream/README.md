# Desktop terminal stream

`/desktop-terminal/v1` is an additive raw WebSocket endpoint. Unlike the legacy
`/user-terminal` gateway, attachment never starts/restarts a process and one view
never evicts another. HTTP creation, listing, actions, command history and cleanup
remain compatible. Lists advertise `streamVersion: 1` when the screen host is
supported. A failed screen worker withdraws that capability; existing HTTP shells
remain usable. Reconnection is an observation operation, never an input retry.

## Owners

`DesktopTerminalGateway` owns upgrades, heartbeat, connections and one focused
input/resize owner per terminal. A client may explicitly claim focus; other views
continue receiving output. `DesktopTerminalConnection` owns its output cursor,
render credits, serialized mutation queue and subscription. Its closure releases
only the view. `DesktopTerminalService` verifies durable task/terminal ownership
at attach and again for each mutation, including process generations and task
finishing. `UserPtyManager` retains process and shutdown ownership.

Process exit does not disconnect output observers. A resize arriving after exit
is validated against the task, terminal, generation and size, then accepted
without changing the retained grid. Geometry updates from a view that has lost
focus are discarded. Rejected input still closes the stream with an uncertainty
flag; geometry-only failures never claim that keystrokes were interrupted.

`TerminalScreenHost`, owned by the PTY manager, uses one worker for all desktop
screens. The worker applies writes and resizes in order, responds to supported
terminal queries and supplies checkpoints/confirmed agent context. Ordinary
HTTP-era shells retain their existing reply behavior; protocol-1 creation or
stream attachment transfers query handling to the server. The renderer consumes
those queries without emitting duplicate replies. View-only replay cannot send
keyboard data or historical device replies to a process.

Worker messages carry a screen incarnation, independently of numeric terminal
IDs. Old completions and protocol replies cannot acquire a replacement PTY.
Checkpoint requests are barriers behind preceding writes. The parser-tail tracker
retains incomplete ESC/C1 sequences because the public serializer only restores
cells/modes/attributes. Headless and visible terminals use Unicode 11 widths and
ConPTY metadata on Windows. Serializer behavior is covered through public buffer
restoration tests; it is not a snapshot of the shell's operating-system process.

## Wire contract and bounds

The upgrade query contains task/terminal identity, generation and an output
cursor. Offsets remain UTF-16 units to preserve existing HTTP consumers. Output
pages carry their producing grid and authenticated command-start offsets. A
generation mismatch or expired cursor restores a checkpoint, chunked into
32 Ki-unit frames. Restore data is capped at 4 Mi units and 2,000 scrollback rows;
oversize or malformed states produce an explicit recovery failure.

Each delivery has an increasing ID. The renderer acknowledges it only after
xterm's write callback commits the cursor. A connection keeps roughly 128 Ki
units in flight (with at most one page of overshoot); it retains counts/cursors,
not unbounded output copies. Expired stalled consumers resynchronize independently.
Input is pipelined, strictly sequenced, generation-bound and never retried. Input
acceptance means passed to the PTY, not displayed or executed by the shell.
There are at most 128 KiB of pending input and 256 queued operations per connection,
128 connections and 128 desktop screens. Individual text/binary writes contain
at most 4,096 units/16 KiB. Binary mouse input remains latin-1 bytes end to end.

The worker's high/low watermarks are 256/64 Ki units per PTY. They include data
waiting in worker IPC, so emulator saturation propagates to PTY pause/resume.
Disposal/failure resumes paused producers and rejects pending requests. A slow
view does not pause hidden jobs or another view. All queues, timers, listeners,
workers and native PTYs have explicit owners and teardown.

Unchanged metadata is not transmitted. OS listener discovery remains a coalesced
1.8-second sample while a view is attached; output itself is event driven. Normal
output reads copy only the requested indexed history window, and short PTY writes
coalesce instead of retaining hundreds of thousands of tiny chunk objects.

## Security and distribution

Browser Origin and Fetch Metadata headers are rejected. Local desktop instances
use the existing private capability header. A conventional backend without that
capability accepts only loopback native clients. SSH uses the existing authenticated
desktop forward and remote Unix socket. No credentials or chosen URLs enter the
renderer bridge, redirects are not followed and production CSP is unchanged.
Frames, identities, sequence transitions and sizes are validated on both sides.

Nest emits the worker beside its host. The backend bundle builds a separate
`terminal-screen-worker.cjs`; local development and local/remote release staging
copy it beside `main.cjs`. New worker dependencies are bundled into that file.
Build the backend before running the real-worker Jest regressions:

```sh
pnpm backend:build
pnpm --dir apps/backend exec jest --runInBand --testPathPatterns='user-terminal|terminal-output-buffer'
```

Real shell/OS tests establish behavior only on their host. Optional fish and
PowerShell tests skip when those executables are unavailable. Native platform
testing is still required for Windows ConPTY and Linux-specific behavior.
