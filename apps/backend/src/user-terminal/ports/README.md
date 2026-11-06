# Terminal listener discovery

`UserPtyManager` owns one `TerminalPortDiscovery`. Each direct desktop PTY
registers its OS PID and a callback bound to that exact stream; exit, replacement,
close and shutdown unregister/abort it. Legacy PTY/tmux behavior is unchanged.
No repository scanning, environment inspection, service probes, native dependency,
renderer networking or persistent process registry is involved.

The collector reads one process table, walks ancestry once for all registered
roots, and reads actual TCP listeners. Birth times reject reused parent/root PIDs;
registration identity rejects replies after close or replacement. No descendant
PID is retained across snapshots. Ordinary pnpm/npm wrappers, grandchildren,
foreground processes, background jobs and shell integration disabled are supported.

## Platform boundary

- macOS: `ps -axo pid=,ppid=,lstart=` with a fixed locale/timezone, then numeric
  `lsof` output for owned descendants. `-a` must combine PID, TCP and LISTEN
  filters; without it lsof ORs selections and includes unrelated sockets.
- Linux: the same process table (bounded `/proc/<pid>/stat` fallback without
  `ps`), `/proc/net/tcp{,6}`, and socket descriptors of owned descendants only.
  Bounded, concurrent fd reads do not traverse unrelated processes. `lsof` is a
  fallback when proc socket access is unavailable. Native word order is handled
  for both IPv4 and IPv6 tables.
- Windows: stock PowerShell/CIM reads PID, parent PID and creation time only;
  `netstat.exe -ano` supplies numeric IPv4/IPv6 socket owners. Remote port zero
  identifies listeners without relying on localized state labels. No removed
  `wmic.exe` or optional PowerShell module is required.

`lsof` exit 1 with complete stdout and no diagnostics is accepted: individual
search terms can be unmatched while other listeners are returned. Signals,
timeout, output limits and diagnostic failures remain failures. See the
[lsof exit-status documentation](https://github.com/lsof-org/lsof/blob/master/docs/manpage.md).

## Scheduling and bounds

List reads await one shared scan. Output reads trigger the same work without
waiting behind it; output delivery remains independent. Completed scans are
cached for 1.8 seconds across tasks/windows. No reads means no scans or polling
timer. Explicit service verification bypasses that cache. Duplicate requests
join one in-flight operation, and registration changes invalidate freshness.

Each scan has an abort deadline of 3.5 seconds, with command timeouts of 2.5
seconds and output caps of 4 MiB. Process tables are capped at 50,000 rows, owned
descendants at 4,096 and Linux fd walks at 50,000 entries. Proc reads are bounded
and fd work runs in batches of 16. Shutdown/last registration cancels work; all
deadline handles are cleared. Collector failures are logged once per failure
transition, with bounded diagnostics, and produce `portDiscovery: unavailable`.
Unknown results clear advertised services; output hints never substitute for
successful listener ownership.

## Presentation and browser handoff

`TerminalServices` owns at most 16 advertised ports and 16 hints. It deduplicates
inherited descriptors and IPv4/IPv6, prefers IPv4 when both are owned, and retains
hinted/current ports before applying the bound. The existing single `port` and
`protocol` fields remain the primary service for old consumers. A matching recent
URL hint chooses the primary; otherwise it remains stable until its listener
disappears, then falls back to the lowest port. The additive `services` array
exposes the bounded set. Background listeners survive shell command boundaries;
PTY exit clears them immediately.

Printed URLs only refine protocol and a confined pathname of owned listeners.
OSC metadata is excluded, ANSI styling is ignored, and query strings/fragments
are discarded. Unclaimed hints expire after 30 seconds; claimed hints are tied
to the socket process's PID/birth time and removed when that owner disappears.
A listener alone does not establish that it speaks HTTP: Browser defaults to
HTTP without sending exploratory requests to arbitrary TCP services.

The additive `GET :id/service?generation=...&port=...` checks durable task
membership, the process generation and a fresh listener snapshot before returning
a confined address. Main validates that address at runtime, including numeric
loopback hosts and canonical pathname bounds. Existing engines without the
discovery metadata keep the previous handoff. Local opening uses the observed
IPv4/IPv6 host; SSH forwards target that exact numeric loopback address and use
their actual allocated local port. An unrelated listener on another address with
the same port therefore cannot receive the browser request. Automatic terminal
forwards persist the exact target and their local-port assignment on the desktop.
Windows share the listener through independent leases; reconnects reuse its saved
port and report conflicts instead of remapping. Manual forward target overrides
remain window-owned.
PTYs retain their existing app-launch lifetime. Saved generic forward definitions retain their
existing format/defaults. The additive SSH wire address is validated as numeric
loopback; old frames without an address retain their IPv4 default.

Only loopback/wildcard TCP binds in the backend's network namespace are listed.
UDP, LAN-only binds, listeners owned by external Docker/VM daemons and fully
detached/reparented jobs are outside terminal ancestry. Permission/tool/resource
failures leave the shell usable but cannot establish a serving port. Platform parser tests are portable;
real PTY/socket tests establish runtime behavior only on the host OS.

## Real Angular regression

With backend and renderer dependencies installed, run from the repository root:

```sh
ELEVENEX_TEST_ANGULAR_TERMINAL=1 pnpm --dir apps/backend exec jest --runInBand --runTestsByPath src/user-terminal/desktop-terminal-angular.spec.ts
```

This opt-in test starts the installed Angular CLI against the actual renderer
through `UserPtyManager`, on an allocated loopback port with a custom serve path.
It checks plain and colored output, replays each actual URL line at every chunk
split, verifies process-owned listener discovery, requests the discovered path
over HTTP, and checks that stopping the PTY clears the service. It requires
permission to start a loopback server and inspect process ancestry. It is skipped
in ordinary backend runs so they do not require renderer dependencies or builds.
