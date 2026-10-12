# Claude subagent integration plan

Claude support needs a reliable task model before more UI polish. The target is a Claude session where the user can keep talking to the parent, follow delegated work in a neighboring panel, handle a child's permission request, and stop one worker without interrupting unrelated work. Reuse Elevenex's regular chat components while preserving Claude's own lifecycle and delivery semantics.

The core audit fixes are implemented: native task state, saved-worker discovery, incremental transcript pages, selective live subscriptions, input acceptance and steering, individual task controls, persistent approvals, and the responsive inspector. The Agent SDK is now **0.3.296**. Elevenex still launches the independently installed Claude CLI and gates controls by its reported capabilities. Agent definitions remain native Claude configuration; the picker uses the runtime catalog. Direct child messaging and child context occupancy remain unavailable where the public SDK does not report or expose them.

The audit findings and implementation sequence below document the rationale. Verification includes native Claude Code 2.1.296 against an isolated fake API, focused runtime/UI tests, and recorded-fixture browser previews in both themes.

## Existing support and gaps

The persistent session runtime, complete child messages attached through `parent_tool_use_id`, task progress summaries, child permission IDs, shared chat rendering, search, and theme tokens are useful foundations. Keep them.

| Priority | Finding in the current implementation                                                                                                                                                                                                                                                                 | User impact                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | [History loading](../apps/backend/src/claude-runtime/claude-runtime.service.ts#L758) refuses to read a child without `transcriptPath`. The installed SDK's start hook has no such field; its stop hook does.                                                                                          | A running child can show “Transcript unavailable” throughout its execution.                                                                                                                  |
| P0       | [Subagent discovery](../apps/backend/src/claude-runtime/claude-runtime.service.ts#L4586) comes from hooks into an in-memory list; `listSubagents()` is unused.                                                                                                                                        | A cold backend or imported session loses its agent list even when native child transcripts still exist. A browser reconnect to the same backend is a different case and can retain the list. |
| P0       | Hooks create `subagent:<id>` background entries while task events independently create `task:<id>` entries. Every start hook is treated as background work.                                                                                                                                           | One worker can count twice. Foreground agents can be presented as background agents.                                                                                                         |
| P0       | Child state has only hook-derived started/stopped values. [The shared status component](../apps/frontend/src/app/shared/agent-chat/activity/subagent-status.component.ts#L5) labels an unspecified stopped outcome “Completed.”                                                                       | Failed, cancelled, or uncertain work can look successful. `SubagentStop` can also be blocked by a hook and followed by more work.                                                            |
| P0       | [Task updates](../apps/backend/src/claude-runtime/claude-runtime.service.ts#L4181) default missing patch status to running, and progress always sets running.                                                                                                                                         | A metadata-only or late update can revive a terminal task. Resumed runs cannot be distinguished from late events from the previous run.                                                      |
| P0       | [Prompt submission](../apps/backend/src/claude-runtime/claude-runtime.service.ts#L1899) queues behind recent background work; [the frontend](../apps/frontend/src/app/features/session/claude-workspace/session-runtime.service.ts#L203) also queues all Claude input while background entries exist. | The parent may be idle but the user still waits for children. Frontend and backend disagree once the backend's five-minute quiet threshold expires.                                          |
| P1       | `Query.stopTask()` exists in the installed SDK but has no Elevenex action. The background list and task drawer have no task navigation or stop controls.                                                                                                                                              | Users can observe work but cannot manage an individual worker.                                                                                                                               |
| P1       | [Tool filtering](../apps/frontend/src/app/shared/agent-tools/agent-tool-format.ts#L673) hides `TaskStop`, `TaskOutput`, and almost all Claude `SendMessage` calls.                                                                                                                                    | Stops, waiting, results, and follow-ups disappear from the conversation. `SendMessage` is also explicitly excluded from the Codex collaboration formatter.                                   |
| P1       | [The inspector](../apps/frontend/src/app/shared/agent-chat/activity/claude-agent-inspector.component.html) is a wide modal with a backdrop and focus trap. It polls a full history request every two seconds.                                                                                         | Inspecting children blocks the parent composer and approvals. Growing transcripts are repeatedly transferred and normalized.                                                                 |
| P1       | The child list is truncated to 25 records, the task list grows without a bound, and every lifecycle upsert replaces the child object.                                                                                                                                                                 | Active or historical workers can disappear; accumulated task snapshots grow; richer metadata can be lost.                                                                                    |
| P1       | [The task drawer](../apps/frontend/src/app/features/session/claude-workspace/components/claude-tasks-drawer.component.ts) groups stopped tasks under “Waiting.” [Terminal mirrors](../apps/backend/src/claude-runtime/claude-terminal-transcript-mirror.service.ts#L645) publish no subagents.        | A cancelled task appears pending; terminal-backed conversations lack child discovery.                                                                                                        |

The history and discovery problems are integration bugs rather than missing Anthropic APIs. They can be fixed while retaining compatibility with 0.2.131.

## Claude behavior to preserve

Claude Code Desktop documents a tasks pane for background subagents and shell work. Selecting an entry opens its output in the subagent pane; entries can be stopped. Its parent composer accepts corrections during work without stopping the running action. That supports a panel beside the main chat and a composer that remains usable. [Desktop documentation](https://code.claude.com/docs/en/desktop#watch-background-tasks), [prompt behavior](https://code.claude.com/docs/en/desktop#use-the-prompt-box).

Foreground children block the parent's execution; background children can continue while the parent handles other work. Agent definitions, tools, permissions, and context are child-specific. Current Claude supports nested workers and resuming eligible agents under the same identity. Explore and Plan are one-shot. A user-stopped child has stricter resumption behavior than an agent stopped by Claude; do not offer a generic resume button that silently asks the parent to undo a user cancellation. [Subagent behavior](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background), [resumption](https://code.claude.com/docs/en/sub-agents#resume-subagents).

The SDK forwards complete child messages. Its token-level stream events are for the main session. Render genuine child messages and task progress; avoid promising token-by-token streaming from children. [Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output).

Hooks provide enrichment, not the authoritative execution result. In particular, a stop hook can require continued work. [Hooks reference](https://code.claude.com/docs/en/hooks#subagentstop).

| Capability                             | Inspected 0.2.131 API                           | Plan for current Claude                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discover saved child IDs               | `listSubagents(sessionId, { dir })`             | Use it during recovery and for terminal mirrors.                                                                                                                         |
| Read child messages                    | `getSubagentMessages()` with limit and offset   | Remove the hook-path prerequisite; add bounded loading and caching.                                                                                                      |
| Stop one task                          | `Query.stopTask(taskId)`                        | Expose for a live process owned by Elevenex.                                                                                                                             |
| Send input during a turn               | User messages already have `priority`           | The wrapper serializes turns. Add a separate input-delivery path and verify priority behavior against the actual CLI.                                                    |
| Authoritative background membership    | No typed level event                            | Newer releases have `background_tasks_changed`; replace the live set from this event.                                                                                    |
| Child identity and ancestry            | Mostly hooks and tool relationships             | Newer releases report message `agent_id`, `parent_task_id`, and separate `run_id` values.                                                                                |
| Move a foreground worker to background | No public wrapper method in the installed types | Current `Query.backgroundTasks(toolUseId)` supports a targeted action.                                                                                                   |
| Direct user messaging to a child       | No public `Query` method                        | The inspected current public `Query` also lacks this operation. Offer an explicitly parent-mediated follow-up; direct child chat needs a separately supported transport. |
| Current child context percentage       | No child-scoped context control                 | Keep unavailable unless authoritative child occupancy is supplied. Task `total_tokens` is cumulative work, not occupancy.                                                |

These version changes are documented in [Anthropic's SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md). The exact API shapes were also checked in the [vendor-published 0.3.296 package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.296) and the installed 0.2.131 types. Upgrade to a tested release at least as recent as 0.3.296, while retaining a capability-gated path for older external CLIs.

## UI and interaction decisions

### One activity entry

Use a compact row above the composer, for example **Agents 4 · 2 running · 1 needs approval**. Clicking the row opens the session's workers; clicking a featured worker opens that worker. Keep the entry available after completion. Fold background agent activity into this entry instead of showing the same worker in a second banner. Shell commands and workflows remain distinct task kinds, reachable through the same activity panel.

Derive counts from the normalized registry. Ambient maintenance and watchers do not inflate activity counts. Present parent state separately: **Claude is ready · 2 agents running** is a valid state. “All settled” must not imply every task succeeded.

### A panel beside the parent chat

On wide screens, open a resizable panel beside the parent conversation. Keep the composer and approval cards reachable. Use a sheet on narrow screens, with a prominent return-to-chat action and visible pending-approval notice. A child requiring approval must never be hidden behind an inaccessible modal.

Keep the regular chat layout: assignment as the first user message, assistant responses, thinking disclosure, tool cards, file links, and collapsed turns. Default to Chat; Activity is secondary; put Hooks and raw diagnostics in Details. Preserve each agent's scroll position and expansion state. When the reader scrolls up, show **New activity** instead of moving the viewport.

The rail shows a stable name or task description, status, and one current-progress line. Nest known children beneath their parent; retain their ancestors when filtering. Sort within each group by launch order. Use explicit labels such as Starting, Running, Needs approval, Waiting for result, Paused, Completed, Failed, Stopped, and Status unavailable. Use semantic success, warning, destructive, and muted tokens consistently.

### Honest controls

Expose **Stop agent** for a currently owned native task. Show Stopping until its terminal event arrives. A failed control request must leave the existing task state intact and provide Retry. Expose **Run in background** only for an eligible foreground task and supported CLI.

Use **Ask Claude to follow up** for an eligible child. Prefill a parent message with the stable agent ID and user-authored direction. Show that it was sent to the parent; only display delivery to the child after observing the native tool outcome. For non-resumable or user-cancelled workers, offer a new delegation or explain the supported recovery path. Do not synthesize a child conversation by launching an unrelated query.

### Parent messages

Background children should not delay a new parent message. During parent execution, default to Claude's documented send-without-stop behavior once verified against the CLI. Offer an explicit queue action for a later turn. Keep interrupt as a separately named action. On older unsupported CLIs, expose the actual fallback behavior and label it **Interrupt and send**, not native steering.

The current `next`, `now`, and `later` fields need an isolated protocol check before assigning UI labels. Newer CLI releases changed `now` behavior to background running actions, making a version-independent assumption unsafe. Serialize input delivery and acknowledgements without serializing all messages behind turn completion.

### Useful Claude tool cards

Render `Agent` and legacy `Task` as delegation cards with clickable worker, task description, expandable assignment, foreground/background state, progress, result, and an optional usage detail. Prefer structured `tool_use_result` over parsing the model-directed trailer.

Render `SendMessage` as a message card with sender, recipient, content, delivery outcome, and a resume indication when known. Distinguish ordinary worker messages from team protocol and cross-session messages. Render `TaskOutput` as a compact waiting/result card and `TaskStop` as a stop event. Retain raw payloads in Details. Keep noisy task bookkeeping collapsed; keep consequential actions visible.

### Context and configuration

Keep context information in the same small footer control as the main chat. Show task tokens, tool count, duration, and last report time under usage details; never turn cumulative tokens into a context percentage. Do not reuse the parent's context reading for a child or poll full context breakdowns for every worker.

Add a small agent picker using `supportedAgents()` so users can discover the definitions Claude actually loaded. Use runtime descriptions and model information, without assuming Explore always uses Haiku. A selection prepares an explicit delegation request in the composer. Existing project/user/plugin definitions remain owned by Claude; editing definitions and advanced fan-out limits can follow after runtime correctness. [SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents).

## Implementation order

### Phase 1 Provider compatibility and protocol fixtures

Update the SDK dependency and lockfile after checking the API changes used by `ClaudeSessionRuntime`, especially settings, permissions, initialization, and interruption. Record the external CLI's version and advertised capabilities from its handshake. Do not update or restart the user's CLI automatically.

Add session-level capabilities for task stopping, backgrounding, input delivery, child messaging, transcript availability, and telemetry. Replace the frontend's Claude-versus-Codex boolean assumptions with these actual capabilities.

Establish the coding-session and meta-agent policy contract at this stage. Verify that native children retain the intended tool boundaries and autonomy mode before enabling their controls or adding delegation shortcuts. Keep native Claude children distinct from Elevenex sessions created by the orchestrator.

In a separate temporary workspace, record a small native event fixture for foreground/background workers, mid-run input, completion notification, targeted stopping, and resumption. Verify default/next/now/later delivery, user-message acknowledgements, autonomous parent turns, and interrupt receipts. This harness must never manage the running Elevenex process or use its active session.

**Acceptance:** old and current CLI fixtures produce an explicit capability matrix; no control is shown solely because the npm package contains a method.

### Phase 2 Normalize child tasks and runs

Extract a pure Claude task reducer from the large runtime service. Maintain one registry keyed by session generation and native task ID, with a separate run ID. Record aliases for hook agent IDs and tool-use IDs when correlation is proven. Use task kind to separate subagents, shells, workflows, MCP tasks, and team work.

Keep `TaskCreate`/`TaskUpdate` planning items outside the execution registry. A task-board item and a running native task have different lifecycles; their identifiers and completion hooks are not interchangeable.

Consume start, patch, progress, terminal notification, and background membership events. A patch without status preserves status. Late events from an older run cannot change the current run; an explicit newer run can reactivate the same child identity. Merge hook fields without replacing other metadata. A stop hook alone must not turn uncertainty into success.

On current CLIs, background membership uses replacement semantics and resets with each process generation. Retain conservative compatibility handling for older CLIs, but remove background membership as a reason to block parent input. Do not use an age threshold as proof that a live process is safe to retire. Preserve existing protection against idle shutdown and option-change restarts killing child work.

Route child messages and callbacks to child activity. They must not start a parent response merely because the parent is idle; register a parent background response only for actual parent output. Store a small lifecycle index for recovery, retaining active records independently of settled history. Bound and paginate settled records rather than truncating active workers or growing every snapshot indefinitely. Any new database storage must use Drizzle schemas and generated migrations.

**Acceptance:** one worker counts once; foreground is not background; late progress cannot resurrect a completed run; resumed workers retain identity; 100 workers do not evict active entries.

### Phase 3 Recover and deliver transcripts efficiently

Introduce a Claude child-history service shared by the runtime and terminal mirror. Discover IDs with `listSubagents()` scoped to the recorded transcript directory. Join saved parent delegations, native child history, and the lifecycle index to recover names, assignments, ancestry, and outcomes where reported. A saved file alone does not prove the worker is still running or completed successfully.

Allow reads without a stop-hook path. Distinguish Starting transcript, Empty transcript, Retained transcript unavailable, and Read failed. Merge streamed complete messages with saved messages by native identity. Treat the selected child's own conversation as its root; preserve nested tool relationships without filtering away all child messages as parent attachments.

Use bounded SDK reads, a cache keyed by session/agent/file identity and modification state, and one coalesced request per child. The SDK's `limit`/`offset` limits the returned page, not necessarily internal file parsing: benchmark it. If it still rereads large files, add an asynchronous incremental index with partial-line recovery and file-rotation handling. Publish updates for the selected child; use adaptive, visibility-aware polling only as a fallback. Share one frontend history store between the session workspace and forked chat.

Respect the child's reported working directory for file links, especially isolated worktrees. Keep terminal-mirrored or historical sessions inspectable while disabling controls that require an Elevenex-owned live process. Do not start a new query just to recover history or telemetry.

**Acceptance:** live history appears before the stop hook; a cold backend restores agents; opening one child does not load every transcript; history survives compaction and session switching without duplicates or stale responses.

### Phase 4 Input delivery and individual controls

Add a low-level input-delivery operation to `ClaudeSessionRuntime` that can push into the existing iterable while a turn runs. Give messages stable UUIDs and human provenance. Keep machine-generated notifications distinct. Correlate user acknowledgements and result UUIDs so an autonomous completion report cannot resolve the wrong user's submission. Preserve pending messages through supported interrupt semantics.

Expose provider actions for stop-task and background-task through the registry, gateway/controller, and frontend API. Validate session ownership, current generation, native task identity, and action eligibility. Repeated clicks are idempotent and never close the shared query. Leave explicit stop-all behavior separately named.

Bind permission callbacks to their abort signals and owning child run. Show the child name with a link to its conversation; retain stable request IDs and accessible Approve/Deny controls. Stopping one child cancels only its requests. Simultaneous requests remain individually reachable. An agent message must not act as permission approval. [Permission behavior](https://code.claude.com/docs/en/agent-sdk/permissions).

**Acceptance:** a parent message starts while children continue; verified native steering does not call interrupt; stopping one child preserves siblings and parent; a cancelled permission callback does not leave the UI waiting forever.

### Phase 5 Shared chat panel and Claude cards

Implement the activity row and responsive panel using Zard components and Tailwind semantic utilities. Keep TypeScript, substantial templates, and styles separate. Reuse the shared transcript renderer rather than extending the existing nested inline stream into a second chat system.

Add a Claude-specific delegation/message formatter alongside the Codex collaboration formatter. Share presentation primitives while preserving provider-specific inputs, statuses, and control capabilities. Test legacy `Task`, current `Agent`, resumed workers without a new Agent call, malformed outputs, and MCP tools with similar names.

**Acceptance:** the parent composer and child approvals remain usable while inspecting; cards open the correct worker; terminal navigation is read-only; keyboard and narrow-screen flows work in both themes.

### Phase 6 Agent surface policy and advanced configuration

Audit coding sessions and the Elevenex meta-agent separately. [The meta-agent prompt](../apps/backend/src/elevenex-agent/meta-agent-prompt.ts) intentionally delegates application work to Elevenex sessions, and [its runtime options](../apps/backend/src/claude-runtime/claude-runtime.service.ts#L5474) restrict editing and worktree tools. Native Claude subagents and separately created Elevenex sessions must retain distinct identities and navigation.

A native child has its own context; the orchestrator's standalone prompt is not automatically its instruction contract. Add any required orchestration constraints to the child definition/delegation and enforce existing autonomy policy at the tool boundary. Do not globally broaden tools or force coding-agent defaults into the orchestrator to achieve subagent parity.

After core acceptance, add definition details and explicit settings for child model defaults, concurrency, nesting, budget, memory, and isolation only where the installed CLI supports them. Preserve native defaults unless the user changes them. Treat reported totals as usage rather than deriving per-worker costs from guessed prices or adding child costs twice to parent totals. [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

## Verification and delivery

The audit baseline passed **120 backend tests** across the Claude runtime and persistent session runtime, plus **38 frontend tests** across the inspector, turn summaries, composer, and collaboration formatter. These mock-based tests verify existing behavior; they do not establish native Claude parity or cover the gaps above.

Desktop task behavior above is based on Anthropic's documented Code interface. No live subagent workflow was executed in the installed desktop app during this audit; protocol conformance and visual parity remain release acceptance checks.

Add focused regressions for the reducer and controls, then replay native protocol fixtures. Exercise missing hooks, reordered task/hook transports, metadata-only patches, repeated events, resumed IDs, concurrent approvals, background completion during a user send, process replacement, stale browser requests, partial JSONL writes, and legacy transcripts. Verify both coding and meta-agent surfaces.

For scale, use a session containing 100 worker records and large child transcripts, with 20 active workers and only one selected transcript. Confirm bounded cache/snapshot size, no repeated full-session scan on each progress update, and no child work terminated by idle cleanup. Use the measured SDK read cost to choose indexing rather than assuming pagination makes disk reads cheap.

For visual acceptance, check light/dark themes, focus restoration, readable status and disabled controls, loading and unavailable states, narrow layouts, long assignments, and parent/child navigation. Use the repository's [Elevenex screenshot skill](../.agents/skills/elevenex-screenshot/SKILL.md) in reuse-only mode for the existing app; an isolated fixture preview must use distinct ports and storage and must never stop or restart the user's process.

Deliver the compatibility/reducer/history changes first, followed by input and controls, then the panel/cards, then advanced configuration. The core release is complete when users can discover, inspect, follow up through the supported route, approve, stop, and recover Claude workers with accurate state and without losing access to the parent conversation.
