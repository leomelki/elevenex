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

`remote/ssh.ts` launches the installed **OpenSSH client** with explicit arguments
and a private generated config. It includes the user's config (or a selected
custom config), retaining aliases, Include/Match, ProxyJump, ProxyCommand,
identities, identity agents, certificates, users and ports. Config files are
trusted executable configuration: Match exec and ProxyCommand can run programs.
Custom config/identity paths must come from the main-process native file picker
or an already saved host. Renderer-provided arbitrary file paths are rejected.

The following settings intentionally override user configuration:

- Host checking is `ask`, DNS-based implicit trust and automatic key updates are
  disabled, and changed/revoked keys are never accepted automatically. OpenSSH
  manages the user's configured known_hosts files. Unknown hosts require an
  explicit fingerprint decision. A changed key requires independent verification
  and repair of known_hosts in a terminal; Retry cannot bypass it.
- Agent forwarding is off unless the saved host explicitly enables it. An
  unlocked local agent can still authenticate without forwarding it. ProxyJump
  children inherit the generated config and keep forwarding disabled.
- ClearAllForwardings prevents configured LocalForward, RemoteForward or
  DynamicForward entries from opening listeners or breaking initialization.
  Recreate desired development forwards with the managed-forward API. We never
  confuse an SSH forwarding warning with a healthy application connection.
- User ControlMaster/ControlPath/ControlPersist, RemoteCommand, backgrounding,
  TTY allocation, X11 forwarding and LocalCommand cannot take over the app's
  process lifecycle. User-supplied ProxyCommand programs remain the user's trust
  boundary, including the behavior of programs they themselves launch.

One SSH stdio channel runs an uploaded Node bridge. It multiplexes bounded TCP
streams, so initialization does not depend on SSH TCP forwarding permissions,
SOCKS, ControlMaster, tmux, a remote login Node installation, or remote internet
access. Managed forwards bind **127.0.0.1 only** and target remote loopback only.
Port 0 requests an OS-allocated local port. Both an occupied local port and an
unreachable remote service have distinct status. A remote-service probe verifies
TCP acceptance, not the arbitrary service's application protocol. Retry forward
rebinds/rechecks it; connection recovery recreates forwards once per generation.

`wire.ts` bounds frames to 96 KiB, data chunks to 64 KiB, aggregate pending output
to 4 MiB and concurrent stream channels to 64 per transport. Each direction has
one unacknowledged data frame, with socket backpressure. Removing a forward
closes its accepted sockets; disconnecting one window cannot close another
window's listeners or shared connection lease.

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
shell interpolation of prompts. Restricted PowerShell compilation requires an
unlocked SSH agent or administrator policy changes. Windows/Linux client runtime
verification and release-platform certification remain outstanding.

The selected desktop release's `elevenex-backend-<target>.tar.gz` and checksum are
downloaded **locally**, using the existing GitHub allowlist, redirect, checksum
and archive validators. A verified local archive cache avoids repeat downloads.
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

The daemon reserves a deterministic remote loopback UDP port in 20000–39999 as
its kernel database ownership lock. An HTTP control listener on the same TCP
port authenticates with that token; neither is an exposed backend API. The
reservation is separate from health traffic so a retained supervisor handle
cannot swallow health requests. A conflicting service is never killed or adopted.
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
operations that need a forwarded agent must wait for a new consenting client.
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
  name: 'Development', host: 'my-ssh-alias', forwardAgent: false,
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
`saveEnvironmentContext` (project/task/session IDs, draft and last event cursor).
Each environment has its own context. Drafts are bounded to 100,000 characters
and saved atomically in the desktop's private `remote-settings.json`. This is a
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
Trust replies require `yes`, null cancels, challenges expire after two minutes,
and only the owning window can answer their current ID. Each attempt allows a
bounded number of interactive prompts. Passwords/passphrases pass through a fresh
authenticated loopback askpass broker, never disk, argv, diagnostics or settings.

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
For compatibility errors, verify the installed bundled Node with `--version`,
remote Git and the selected release's platform prerequisites in a terminal.

## Verification and limits

`pnpm desktop:test` includes native subprocess bootstrap/cache reuse, interrupted
upload cleanup, binary tunneling/backpressure, OpenSSH config evaluation,
authentication/trust failure classification, stale replies, cancellation,
concurrent-window leases/challenges, forward conflicts and restore/draft tests.
The existing backend tests continue to check process-tree cleanup and revision
readiness. IPC tests cover sender ownership, runtime validation, event cleanup
and negative TypeScript contracts. The native Electron smoke verifies the real
sandboxed preload and multiple-window isolation using an isolated backend and
protocol fixture, not a packaged or fully rendered product.

No live customer SSH server, real MFA provider, Windows/Linux client launch, or
download of a newly published socket-capable runtime is asserted by these tests.
Release CI must publish and certify the matching platform archives. Packaging
and the product renderer build also still need the separately documented design
token inputs. No UI, dependency upgrades, SSH library, remote package manager,
or frontend network permission is added by this implementation.
