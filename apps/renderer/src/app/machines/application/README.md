# Production machine flow

The lazy application route composes the existing MachineHome, MachineLaunch,
AddMachine, title island and NewProject components. Their supplied-data APIs
remain usable independently. The legacy frontend is unchanged.

| Owner | Responsibility |
| --- | --- |
| Desktop `machines/MachineApplication` | Ordered per-window lifecycle/directory snapshots, validated window intents, ready-machine completion |
| Desktop `machines/MachinePreferences` | Atomic, monotonic first-run flag; flush before application shutdown |
| Desktop `RemoteManager` / `BackendManager` | Existing SSH leases, recovery, authentication, engine installation and processes |
| `MachineConnectionService` | Typed preload calls, subscription lifetime, ordered snapshots and stale-bootstrap rejection |
| `MachineLauncherService` | Selected/pending/open view, coalesced selections, last-intent guards, workspace preparation acknowledgement, ready-card settling and cancellable launch timers |
| `SshSetupService` | One unfinished host draft, debounced/bounded suggestions, validation and save/connect intent |
| `RemoteChallengeDialog` | Transient credential/trust UI, expiration and secret clearing |
| `MachineApp` | Window composition, retained modals, title island, update/recovery presentation |
| `MachineWorkspace` | Connected AppShell composition, scoped feature providers, first-project flight and side-view shells |

Home starts passively: saved servers are not contacted until selected. Returning
Home keeps this window's connection until a different machine is selected or it
is explicitly disconnected. Command/Ctrl-open sends a named new-window intent
without changing this window. Existing RemoteManager callers retain their default
restoration semantics; main explicitly requests passive Home for ordinary windows.

Selecting a machine keeps Home's available space fixed. Preparation and pending
opening appear only on the machine card and in the title island; there is no
bottom status/cancel row that resizes Home and shifts its centered grid.

The application subscribes before reading its initial snapshot. Main revisions
order all machine data, including shared connection presence and host changes
from other windows. Other windows' credentials, challenges and context never
enter that presence directory. Launch additionally requires a matching ready
BackendClient scope; readiness alone from another window cannot launch a stale
selection. First-run completion is persisted after a machine actually opens.

SSH suggestions read explicit aliases from the user's top-level config with
a 1 MiB read limit and eight results. They never run `ssh -G`, evaluate Match
commands or implement an alternative SSH policy. Included aliases can be typed
directly; OpenSSH resolves Includes, ports, identity files, ProxyJump and trust.
The real askpass prompt supplies the fingerprint and expiring challenge ID.
Changed-host-key failures are not bypassed by accepting a fabricated fingerprint.
Credential responses are never persisted or logged. Cancelling an in-flight host
save may leave a saved card, but cannot subsequently start its connection.

The machine view stays mounted through Home and updates, and is keyed by machine
identity when switching. Initial preparation stays on Home cards; only an update
inside an already open view uses full-window GettingReady. Reconnects leave
content readable with retry/change actions. The connected workspace uses the
existing BackendClientService scope and owns its bounded pages, drafts and stale
selection guards. Domain caches and project mutations stay outside the connection
service and presentational components. The workspace code prefetches when Home
is idle without instantiating task features or contacting saved servers. Selecting
a machine mounts only that candidate behind inert Home. `MachineWorkspace.preparing`
allows scope-bound navigation reads before launch; `active` separately owns
interaction. After the first render and two animation frames,
`prepared({machineId, generation})` acknowledges the paint boundary. The launcher
requires that acknowledgement and the matching ready backend before opening. Network replies
do not gate the acknowledgement. This moves first-use templates, styles and
layout out of the opening animation. Cancellation/switching rejects old
acknowledgements by candidate generation and disposes pending frames. A retained
candidate acknowledges the new generation even if reselection preceded Angular's
next render. The existing workspace remains mounted for a warm return from Home.

This slice supports local and SSH machines. Peer transport is not implemented;
the pairing card explains availability without collecting unusable pairing text.
The ready machine opens the [connected workspace](../../workspace/README.md).
An empty backend shows the existing NewProject card over inert shell regions.
Its named project/folder adapters operate on the selected machine; the shell owns
the face flight and return to the visible workspace. Its prominent New task
action receives focus; task creation starts only when requested. Selected sessions
show the task header with an empty main region. Side views currently provide
their tabs and frames only.

`preview/machine-startup-*` supplies a deterministic platform for the **production
composition**, outside its production import graph. `/machine-startup` exposes
controlled readiness, trust, sign-in, errors and recovery. Native regression:

```sh
pnpm desktop:capture scripts/desktop-capture/scenarios/machine-startup.mjs --url http://127.0.0.1:4310 --timeout 180
```

Use the existing machine motion/onboarding scenarios for detailed primitive
geometry and interruption checks. Unit tests cover snapshot races, launch
cancellation, repeat/last selections, credential cleanup, persistence and IPC.

`scenarios/machine-first-open.mjs` additionally checks first/warm launches,
workspace creation before animation, inert preparation without focus theft,
ready-backend opening, reversals and narrow reduced motion in both themes.
It records native frame intervals and long animation frames as diagnostics,
without imposing a hardware-independent FPS threshold.

Preparation failures stay on their machine card with a stopped progress value and
retry action. Only host-trust errors use the safety tone; the Home island stays
amber. The launcher retains the last observed progress through a failed snapshot
and clears errors when preparation restarts. Main's raw diagnostic remains in the
machine's last status; the card uses its first sentence. Failed preparation no
longer duplicates the card with a global toast. Unavailable window/IPC operations
still report their owning operation's error.

On Home, the island prioritizes failures and preparation and points at the
relevant card. After Change, a still-connected current machine supplies Back;
clicking runs the normal ready-machine launch again. Rest opens Find, or points
at the local card on first run. The machine panel remains the island's action
inside an open workspace. Command/Ctrl+O belongs to the owning window and is
inactive while a machine or modal is open.

An observed server error remains on its card after selecting another machine,
until that destination starts preparing again or becomes ready. Shared directory
snapshots also expose preparation/failure without contacting servers from Home.
The memory is scoped to the launcher and discarded when its owner is destroyed.

`MachineActionsService` owns Home's menu, retained edit draft, native identity
choice, optimistic removal and at most three Undo notices. ConnectionService
remains the typed, window-scoped platform adapter. Name/color changes persist
without touching connections. A changed host/user/port/identity invalidates old
selects, retires the shared transport and checks the new destination on Home;
it never creates a pending launch. Other connected windows reacquire their lease.

New named machine IPC operations leave legacy `saveRemoteHost` / `removeRemoteHost`
semantics intact: those continue to require an idle host. Main validates new
payloads, the trusted sender and resource identity; SSH identity files still
require the existing native-picker grant. Local appearance shares the atomic
preferences file with first-run state and serialized writes preserve both.

Removal validates occupancy again in main. Confirmed removal closes owned leases
and forwards and returns every affected window to Home. It forgets the saved
host and local window context/forward preferences, touching no remote files or
processes. Undo uses an opaque, single-use, window-owned token retained only in
main, restores the same host ID at its saved index, and starts no connection.
Dismissal, eviction after three notices, and window disposal release Undo data.
An old token from a different window cannot restore a host or grant file access.

The reference describes forgetting an application-pinned host key. This desktop
uses native OpenSSH trust and has no separate application-pinned key to remove;
it preserves the user's SSH config and known_hosts. The confirmation therefore
names only the card and connection. Peer presentation includes Edit/Unpair and
pairing metadata, but peer transport remains outside this production slice.
