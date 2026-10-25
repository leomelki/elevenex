# Remote development backend

This implements the new desktop's system and typed IPC boundary. It does not
add frontend UI or port the legacy frontend/backend clients. The legacy app and
the application-owned local backend keep their existing behavior.

## Ownership and transport

`remote/manager.ts` owns saved hosts, window environment selections, drafts and
forwarding leases. Each saved host has one `RemoteConnection` coordinator. It
owns authentication, setup, readiness, health checks and recovery; forwards do
not run competing SSH reconnect loops. Separate aliases pointing at the same
remote account can have separate transports, but the remote daemon's kernel
lock still permits only one backend/database owner.

`remote/ssh.ts` launches the installed **OpenSSH client** and lets it resolve its
normal user and system configuration. There is no app implementation or whitelist
of SSH settings, and no extra `ssh -G` evaluation during connection. A selected
custom config uses `-F`, through a private Include-only file: some clients embed
the `-F` pathname unquoted in ProxyJump commands, so this indirection preserves
chosen paths containing spaces or shell syntax. As with native `ssh -F`, a custom
file replaces default user/system configuration. Config files are trusted
executable configuration: Match exec, ProxyCommand and enabled LocalCommand can run programs.
Custom config/identity paths must come from the main-process native file picker
or an already saved host. Renderer-provided arbitrary file paths are rejected.
Selected paths are treated literally, including spaces, quotes, percent signs,
glob characters and environment-like text. Identity overrides retain precedence
over configured identities without changing the keys used by a jump host.

Connection policy follows OpenSSH configuration: aliases, Include/Match,
ProxyJump/ProxyCommand, identities/agents/certificates, authentication, trust,
DNS host verification, host-key updates, fingerprint display, forwarding, X11,
tunnels, LocalCommand, timeouts, keep-alives, retries and logging. ProxyJump
children evaluate their own matching rules. Configured user and port apply
unless the user supplies an explicit override in the saved host. The remote account's
`SSH_AUTH_SOCK` is preserved, whether supplied by SSH or a remote shell setup.
There is no separate application consent toggle. Old saved host toggles are
discarded when settings load; saved hosts retain their other settings.

Only the app's session requirements are supplied as command-line options:

- `-T`, `RemoteCommand=none`, `SessionType=default`, `StdinNull=no` and
  `ForkAfterAuthentication=no` reserve a foreground, non-PTY stdio command for
  the bridge. A configured terminal or RemoteCommand cannot replace that program.
- `ControlMaster=no` prevents this owned process from publishing a shared master
  whose termination would disrupt other sessions. An existing configured
  ControlPath is reused normally; neither its master nor its listeners are
  stopped by app disconnect. ControlPath and ControlPersist are not rewritten.
- Background restoration adds `BatchMode=yes` and denies UI prompts. Explicit
  connect/retry retains the user's BatchMode. Interactive asks use the app's
  SSH_ASKPASS broker; the real DISPLAY environment is preserved.

Configured LocalForward, RemoteForward and DynamicForward listeners are managed
by OpenSSH, separately from the app's managed-forward API. Conflicts and server
restrictions obey ExitOnForwardFailure: fatal failures pause with configuration
guidance, while nonfatal warnings retain native behavior. OpenSSH owns whether
configured listeners expose loopback or other interfaces. Enabled LocalCommand
runs normally; background commands must redirect their output rather than write
into the bridge's protocol stream. User-owned proxy programs retain their own
process behavior. App deadlines and cancellation still bound operations even
when an SSH configuration requests a longer wait.

One SSH stdio channel runs an uploaded Node bridge. It multiplexes bounded TCP
streams, so initialization does not depend on SSH TCP forwarding permissions,
SOCKS, ControlMaster, tmux, a remote login Node installation, or remote internet
access. Managed forwards bind **127.0.0.1 only** and target remote loopback only.
Port 0 requests an OS-allocated local port. Both an occupied local port and an
unreachable remote service have distinct status. A remote-service probe verifies
TCP acceptance, not the arbitrary service's application protocol. Retry forward
rebinds/rechecks it; connection recovery recreates forwards once per generation.

`wire.ts` bounds frames to 96 KiB, data chunks to 64 KiB, aggregate pending output
to 4 MiB and concurrent stream channels to 64 per transport. Each channel has a
512 KiB byte-credit window in each direction. Readable-mode pumping splits large
prefetched chunks, preserves TCP half-closes, and respects shared transport
backpressure. A stalled channel cannot consume another channel's credits or
block a separate service. Removing a forward
closes its accepted sockets; disconnecting one window cannot close another
window's listeners or shared connection lease.

Host progress reaches only windows selecting that host; draft and forward
updates reach only their owning window. Unrelated windows do not repeatedly
receive cloned context snapshots during a download or typing burst.

## Setup and remote work lifetime

The host must provide a POSIX shell, uname, Git, tar, gzip, base64, head with `-c`,
mktemp, and sha256sum or shasum. Supported remote targets are **Linux glibc and macOS,
x64/arm64**, subject to the OS/libc requirements of the selected release's
bundled Node and native modules. Alpine/musl and Windows SSH servers need a
different runtime/bootstrap and are rejected. Home paths longer than the Unix
socket limit require a shorter remote home. No administrator access is required.

Use a modern OpenSSH client (9+). macOS is the validated client host. Linux uses
the same POSIX launcher. Windows client support uses installed OpenSSH and a
small credential-free .NET askpass executable compiled with built-in Windows
PowerShell Add-Type into the attempt's temporary directory; there is no command
shell interpolation of prompts. Interactive prompting requires policy to allow
that compiler; agent-only background restoration does not compile it. Windows/Linux client runtime
verification and release-platform certification remain outstanding.

The selected desktop release's `elevenex-backend-<target>.tar.gz` and checksum are
downloaded **locally**, using the existing GitHub allowlist, redirect, checksum
and archive validators. An application-owned archive cache coalesces concurrent
downloads, hashing and extraction across hosts. Cancelling one host only releases
its own lease; preparation aborts after its last owner leaves. A verified local
archive cache avoids repeat downloads.
The archive streams over the already authenticated SSH channel into a private
remote staging directory. The remote independently checks its checksum, tests
bundled Node, and atomically publishes the immutable installation. A healthy
remote cache skips download/upload entirely. No previous version or user data
is removed during an update. Interrupted uploads clean their own staging files;
SIGKILL/power loss can leave harmless `.install-*` directories for later manual
cleanup. Damaged published caches require moving that version aside, rather
than risking replacement of code another client may be running.

The new remote data root is `~/.elevenex/desktop-remote/`, separate from both
legacy remote data and local desktop data:

| Location | Lifetime |
| --- | --- |
| `runtimes/<release>-<target>/` | Immutable backend and bundled Node caches |
| `clients/<source-hash>/` | Immutable bridge/supervisor code |
| `data/` | Database, tasks, sessions, agent workspaces and app-owned caches |
| `backend.sock`, `agent.sock` | Private, mode-0600 runtime sockets |
| `control-token` | Mode-0600 daemon authentication token; never renderer-visible |
| `daemon.json` | Atomic mode-0600 discovery record for the current control listener |

The daemon reserves a deterministic remote loopback UDP port in 20000–39999 as
its kernel database ownership lock. The HTTP control listener uses an
OS-allocated TCP port recorded in `daemon.json`, so an unrelated TCP service
cannot prevent setup. Requests and responses authenticate with fresh nonces,
timestamps and HMAC proofs; the token is never sent to a stale/reused TCP port.
Neither listener is an exposed backend API. The
reservation is separate from health traffic so a retained supervisor handle
cannot swallow health requests. A conflicting service is never killed or adopted.
An unrelated UDP reservation on the ownership port still requires intervention;
it is never treated as permission to start a second database owner.
The backend itself uses the private Unix socket through the opt-in
`ELEVENEX_DESKTOP_SOCKET` setting. Existing launchers continue to use TCP.
This requires a backend release containing this change; the earlier local-only
lifecycle release is not a remote-socket-compatible runtime.

The existing backend process-tree supervisor is reused. It must acquire the
daemon's kernel lock handle **before** spawning a backend, and retains it until
cleanup completes if the daemon dies. This prevents a replacement daemon from
racing an orphan database owner. Exit code 75 and unexpected backend exits get
bounded daemon-owned restart attempts. Daemon and connection recovery own
different resources and never launch a second backend over a live lock.

**SSH loss, sleep, window closure, intentional disconnect and application quit
leave remote backend work running.** Tasks, sessions and active agent runs belong
to the remote backend, not the tunnel. Forwarded-agent access is a short-lived
lease refreshed by bridge health checks and removed on disconnect/expiry; it
is not permanently captured by the daemon. After all clients disconnect,
operations that need a client-provided agent must wait for a new client whose
SSH configuration or remote account environment supplies a socket.
The stable agent proxy tries another live lease if an agent socket has died,
before consuming any authentication/signing bytes. It never retries a signing
request after connecting. Revoking one lease closes only that lease's clients;
agent connection attempts and idle time are bounded.
Backend/daemon crashes or host reboots can interrupt agents; this layer does not
invent automatic agent-run resumption.

A live daemon at a different revision pauses with a compatibility error instead
of interrupting remote work or attempting a concurrent database migration.
Finish the work and disconnect other clients before stopping that daemon on the
remote host, then Retry to start the newly installed revision. Identify the
exact `runtime.js daemon <root> <installation> <revision>` process with
`ps -ax -o pid,command` and send **that verified process** SIGTERM. The daemon
gracefully stops its owned tree. Never use a stale PID file or kill all Node
processes. Automatic cross-revision handover of active work is not supported.

## IPC integration

All methods are on the existing `window.elevenex` bridge. Main-frame/origin
validation, strict argument counts, field validation and sender-derived window
ownership apply to every operation. Events carry no Electron objects and return
unsubscribe functions. Environment events and challenges go only to their
owning window. Saved hosts are shared; editing/removing a host requires releasing
its active leases in every window.

```ts
const stop = window.elevenex.onEnvironmentChanged(snapshot => {
  // Render setup/recovery, context and this window's challenge/forwards.
});
const initial = await window.elevenex.environmentStatus();
const configFile = await window.elevenex.chooseRemoteSshFile('config');
const host = await window.elevenex.saveRemoteHost({
  name: 'Development', host: 'my-ssh-alias',
  ...(configFile ? { configFile } : {}),
}, null);
await window.elevenex.selectEnvironment({ kind: 'remote', hostId: host.id });
// Operations return snapshots promptly; setup progress is asynchronous.
await window.elevenex.retryRemote();
await window.elevenex.pauseRemoteRecovery();
await window.elevenex.disconnectRemote();
await window.elevenex.selectEnvironment({ kind: 'local' });
stop();
```

`environmentBackendStatus()` resolves the selected environment's existing backend
endpoint; `backendStatus/retryBackend/restartBackend` retain their local-only
compatibility. The tunnel transparently carries the existing HTTP/WebSocket
backend protocols, so files, Git and agent execution stay on the remote host.
The privileged local backend tunnel also requires a fresh capability header,
available only to main-process adapters through `RemoteManager.backendAccess`.
An untrusted website probing loopback receives 403; IPC snapshots never contain
this header. Explicit development-service forwards do not inject this backend
credential. Normal backend HTTP connections close after their authenticated
request; an authenticated WebSocket upgrade retains its stream.
This is a system transport boundary, not a new renderer HTTP client. Production
CSP still disallows arbitrary loopback HTTP/WebSocket access. Future frontend
integration must use focused typed domain adapters or a separately reviewed,
constrained protocol; do not loosen CSP or expose a generic shell/HTTP IPC method.

Subscribe before reading a snapshot. Save selection context with
`saveEnvironmentContext(context, expectedEnvironment)` (project/task/session IDs,
draft and last event cursor). Main rejects a late update from an old environment.
Each environment has its own context. Drafts are bounded to 100,000 characters
and saved atomically in the desktop's private `remote-settings.json`. Rapid
updates coalesce to one active write and one latest pending snapshot rather than
queuing every keystroke. This is a
local recovery copy, not an offline mutation queue. Window slots are restored
in creation order on launch; a recreated connected slot reconnects without
interactive prompts. Intentional disconnect and pause persist until explicit
connect/retry. Closing a window retains its saved restore intent.

The connection snapshot distinguishes authentication, setup stage, transport
health and application readiness. `ready` requires a bridge health reply **and**
an end-to-end `/api/info` response at the exact expected revision. Neither a live
SSH process nor an open listener qualifies. Health checks also run immediately
after native resume/unlock notifications. Timeouts bound SSH authentication,
setup stages, downloads, bridge requests and application health.

One retry coordinator uses exponential backoff with jitter capped at 30 seconds.
Transient failures retry automatically; authentication, trust, configuration and
compatibility failures pause. Only explicit connect/retry can present a challenge.
Unsupported SSH algorithms, expired/restricted accounts, denied shell execution
and invalid config environment references pause with an actionable error.
Retry now cancels stalled background authentication and queues one interactive
attempt after its owned processes finish cleanup. Setup already past
authentication can finish without restarting a download; repeated retries never connect twice.
Host trust follows the configured OpenSSH policy; the app does not force ask,
disable DNS verification or override automatic host-key updates. Trust and
confirmation replies require `yes`, null declines, challenges expire after two minutes,
and only the owning window can answer their current ID. Each attempt allows a
bounded number of interactive prompts. Passwords/passphrases pass through a fresh
authenticated loopback askpass broker, never disk, argv, diagnostics or settings.
The broker supports SHA-256/MD5 fingerprint prompts, confirmations such as
AddKeysToAgent ask, and informational agent/security-key notifications. A PIN
prompt can coexist with a notification. Closing an SSH helper cancels its stale
challenge; informational notifications require no credential response.

Every successful reconnection increments `generation`; a restarted daemon also
changes `instanceId`. Consumers must discard asynchronous results from an older
selection/generation and reconcile selected task/session IDs and incremental
cursors before resuming interaction. Reconnect never recreates a task/session,
replays a command or resubmits an agent prompt. A lost reply to a mutation has an
**unknown outcome**: query remote state first. Existing task creation supports
its requestId deduplication; do not assume all session/agent operations do.
Large directory, branch and history data stays behind existing bounded domain
queries; connecting/recovering performs no repository or history rescan.

`remoteDiagnostics()` returns at most 100 structured stage/code/timestamp/revision
entries. Raw SSH/agent/backend output and credentials are deliberately excluded.
OpenSSH's bounded stderr tail is classified in memory; its configured LogLevel
is retained. QUIET logging can therefore reduce available failure detail. Raw
messages never enter IPC or saved logs.
For compatibility errors, verify the installed bundled Node with `--version`,
remote Git and the selected release's platform prerequisites in a terminal.

## Verification and limits

`pnpm desktop:test` includes native subprocess bootstrap/cache reuse, interrupted
upload cleanup, binary tunneling/backpressure, OpenSSH config evaluation,
authentication/trust failure classification, stale replies, cancellation,
concurrent-window leases/challenges, forward conflicts and restore/draft tests.
Manager race tests cover rapid A → local → A switches, host edits while a
selection is saving, retired-connection cleanup, shutdown and failed settings
writes. Stream tests cover 2 MiB responses after EOF, oversized prefetched
chunks, full channel capacity, stalled peers, shared output backpressure and
delayed acknowledgements.
The existing backend tests continue to check process-tree cleanup and revision
readiness. IPC tests cover sender ownership, runtime validation, event cleanup
and negative TypeScript contracts. The native Electron smoke verifies the real
sandboxed preload and multiple-window isolation using an isolated backend and
protocol fixture, not a packaged or fully rendered product.

Where `/usr/sbin/sshd` is available for a non-root listener, a permanent native
test uses disposable keys, an isolated known_hosts file and an owned ssh-agent.
It covers real host trust, changed keys, wrong passphrases, background agent
authentication, jump aliases, custom agent sockets, conflicting configured
local/remote/SOCKS forwards, forward conflicts, LocalCommand, MD5 fingerprints,
configured trust and password-prompt policies, literal config/identity paths,
explicit user/port/key overrides, incompatible cipher rejection, full runtime
bootstrap with server TCP forwarding disabled, the authenticated backend tunnel,
and the persistent backend's agent access/revocation. Forwarding regressions cover
yes/no/unset settings, custom sockets, environment references, Match final and
different rules on the jump and target.
Native tests also verify existing master reuse and survival after app cleanup,
AddKeysToAgent confirmations and native default config discovery. Hardware-key
notifications and overlapping PIN requests have broker-level regression tests;
no physical security key or privileged tunnel/X11 server is certified by them.
It never uses personal SSH credentials or writes its runtime into the real home
directory.

On the development macOS host, that loopback SSH fixture with one jump and
programmatic encrypted-key unlocks measured approximately **0.7–1.1 seconds**
for a new daemon and **0.5–0.6 seconds** for a warm reconnect. The fixture backend
is small and its runtime is already cached; these figures exclude a real release
download and human input. A separate 4 MiB stream fixture with 40 ms ACK delay
took approximately **0.3 seconds**, demonstrating pipelining rather than WAN
throughput. These are diagnostic measurements, not performance promises.

No live customer SSH server, real MFA provider, Windows/Linux client launch, or
download of a newly published socket-capable runtime is asserted by these tests.
Release CI must publish and certify the matching platform archives. Packaging
and the product renderer build also still need the separately documented design
token inputs. No UI, dependency upgrades, SSH library, remote package manager,
or frontend network permission is added by this implementation.
