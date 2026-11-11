# Session activity across harnesses

The desktop Activity panel owns delegated work and noteworthy runtime events.
The conversation owns the main reply, approvals and questions; the agent picker
owns model configuration and subscription allowance. Activity must not duplicate
routine tool receipts or successful hooks from the conversation.

## Gaps and implementation approach

| Harness | Gap in the initial panel | Integration |
| --- | --- | --- |
| Claude Code | Foreground agents and their background action were absent; child transcripts were inaccessible | Project live agent records alongside authoritative background work, advertise per-item controls, and read child history on demand through the existing provider |
| Codex | Waiting/interrupted/unavailable states collapsed into running/success; child context and model were dropped | Preserve native execution states, model and reported context occupancy; expose the existing child-history reader; do not invent individual Stop support |
| OpenCode | Child sessions existed without `backgroundWork`; compaction used a different field; child timestamps described creation rather than completion | Derive the live list from owned child sessions, preserve lifecycle timestamps, and map native retry/compaction events |
| Pi | Retry/compaction events were ignored and optional activity fields stayed empty | Consume native RPC retry/compaction events; keep delegated-agent controls absent because the adapter does not support subagents |

## Interaction contract

- A compact trigger summarizes live work and attention, with a quiet history
  button after completion. Empty activity has no trigger. Opening acknowledges
  existing issues for that mounted conversation, not issues arriving afterward.
- Work waiting on a decision is grouped under Needs you, above running work.
  Live rows identify the agent/task and its role, its actual state, latest
  useful step and elapsed wall time. Answer is offered only while the
  conversation holds the approval or question to focus; Activity never answers
  for the conversation.
- Model, reported usage and context occupancy appear in the agent inspector.
  Missing counts remain unknown; context occupancy is distinct from cumulative
  token consumption. Engines may report `title` and `role` separately; `label`
  keeps the joined form for older desktops, and the desktop never parses it.
- Inspect opens a retained modal with assignment, model, context and a bounded
  child transcript. History is fetched only on opening, explicit refresh, paging and reachability recovery. Navigation/closing cancels requests and rejects stale replies. Errors,
  unavailable transcripts and first-message waits have distinct recovery UI.
- Stop and Run in background appear only for an implemented provider operation
  and a currently eligible item. Main validates IDs and replies; the backend
  rechecks ownership and live eligibility immediately before dispatch. Archived,
  disconnected or uncertain conversations cannot mutate. No action or prompt is
  automatically retried after reconnection.
- Interrupted, stopped, closed, failed and unavailable agents never become a
  successful completion merely because their native lifecycle stopped.
- Recent events show useful failure text, retry progress/delay where reported,
  and compaction facts. Longer event details are disclosed locally without a
  second read. No secret/provider configuration or arbitrary runtime paths cross
  the bridge.

## Data and scaling

Foreground records are included only while their parent run is active and the
provider explicitly identifies them as foreground. After the parent ends, only
the authoritative live registry can keep work active; retained history must not
resurrect phantom work.

Activity travels on the existing selected-session feed. Provider events wake
that feed; elapsed labels tick locally. Lists and text are bounded, with total
counts when rows are truncated. No new history polling or per-agent subscriptions
are installed. Codex child discovery preserves native activity metadata and fills
missing names, roles and model settings with one metadata-only `thread/read` per
child. Reads coalesce across notifications, run at most four at a time, and reject
replies after session replacement or cleanup. Failed reads back off until a later
lifecycle event; no polling timer is installed. Live assignment, settings, usage
and bounded assistant previews update the existing feed independently of the
inspector. Preview publication is limited to four updates per second per child;
metadata and previews do not invalidate the parent's persisted transcript.
Child history uses a named, scope-bound bridge operation and the
provider's ownership checks; no renderer-selected filesystem paths are accepted.
Existing legacy API shapes remain available. Optional new DTO fields permit
older backends and desktops to retain their behavior.

## Feature opportunities and boundaries

| Feature | Best integration |
| --- | --- |
| Individual Codex/OpenCode interruption (implemented) | Codex reuses native child-turn interruption and confirms the selected turn ended; OpenCode aborts only an owned child and confirms its status. Neither operation stops the parent |
| Agent follow-up | Use a typed provider-native follow-up operation with acknowledgement and unknown-outcome recovery; do not synthesize a parent prompt containing hidden instructions |
| Agent hierarchy | Retain parent IDs in runtime records; show a bounded ancestry label rather than fetching entire trees |
| Native child approvals/questions | Keep decisions in the existing question/approval owner, carrying child identity; Activity points out waiting work without offering a competing decision flow |
| Full live child chat | Add visibility-owned incremental cursors and cancellation before enabling streaming; explicit refresh is the bounded first slice |
| Pi extension-specific background jobs | Require an explicit extension capability and authoritative lifecycle; tool names alone cannot prove a detached process is still running |
| Hook management or retry controls | Keep configuration in settings. Activity explains failures; it must not rerun hooks or replay upstream requests |

The reusable capture scenario uses real production Angular components with
isolated provider-shaped preview data. It verifies UI behavior, not authentication
or successful execution against four installed, signed-in native harnesses.
Runtime/provider tests establish event mapping and ownership separately. Per-run
reports and screenshots belong under ignored `artifacts/`.

Pi event mapping follows the [native JSON/RPC event reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md), including retry completion and compaction failure/abort. Older `auto_compaction_*` names remain accepted.

## Implemented capabilities

| Capability | Claude Code | Codex | OpenCode | Pi |
| --- | --- | --- | --- | --- |
| Live delegated work and native status | Yes | Yes | Yes, from owned child sessions | No subagent capability |
| Individual Stop | Runtime-gated task/agent controls | Owned child turn, confirmed stopped | Owned child abort, status confirmed | Hidden |
| Run foreground agent in background | Runtime-gated | Hidden | Hidden | Hidden |
| On-demand child transcript pages | Native cursor plus bounded desktop window | Existing owned rollout/live reader plus bounded desktop window | Owned child messages plus bounded desktop window | Hidden |
| Model/context in agent details | When reported | When reported | When reported by child message events | Not applicable |
| Retry/compaction activity | Native runtime fields | Native retry notifications and compaction receipts | Native retry/status and compaction events | Native RPC events |
| Hooks | Failures/cancellations | Hidden when unreported | Hidden when unreported | Hidden when unreported |

The child reader checks the selected task/session and known child identity before
calling the provider. It does not attach an archived session or create a cold
OpenCode conversation merely to inspect an arbitrary ID. Provider adapters retain
their own second ownership check. Codex/OpenCode still use their existing internal
history readers; the desktop bounds the returned window and does not poll it.
Native pagination inside those provider readers and live inspector cursors remain
future improvements. No synthetic follow-up prompt or unsupported action is sent.
