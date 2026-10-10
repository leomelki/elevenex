# OpenCode provider

Choose **OpenCode** when creating a session or configuring an agent preset. Install the OpenCode CLI on the machine running the backend. Existing OpenCode configuration and credentials are used automatically. `OPENCODE_BINARY` can select a specific executable, including remote installations.

Use **Agent settings → Connect model provider** in an existing OpenCode conversation to add another account, including when free or project models already work. The login card discovers provider authentication methods. API keys, browser OAuth, and manual OAuth codes are supported. Providers requiring additional setup forms or command-based authentication can be configured with `opencode auth login`, then checked again in Elevenex. API keys are submitted directly to OpenCode's credential store; Elevenex does not persist them in its settings or database.

## Architecture

`OpenCodeAgentRuntimeProvider` implements the shared agent runtime contract. `OpenCodeServer` owns an authenticated loopback-only CLI server, with async startup, coalesced requests, cancellation, and bounded idle cleanup. Servers are started on demand for open conversations. Detached idle servers expire after five minutes, with at most six retained. A separate cached control server handles global catalogs and authentication.

The CLI's major version selects an official SDK adapter: `@opencode-ai/sdk/v2/client` for OpenCode 1.x, and `@opencode/client` for OpenCode 2.x. `OpenCodeClient` defines the small protocol boundary consumed by Elevenex. Native execution, tools, plugins, configuration resolution, and model integrations stay inside OpenCode. The v2 adapter normalizes its event and message schemas without reimplementing its agent loop.

The v1 and v2 client adapters own protocol-specific operations separately from server process handling. `OpenCodeTranscriptStore` owns transcript identity, ordering, cached history, and reconciliation with concurrent events. `OpenCodeSessionTree` resolves every level of descendant ownership, coalesces ancestor lookups, and limits concurrent child-list requests. `OpenCodeV2Events` normalizes native events and recovers in-flight tools and assistant metadata after a missed start. These modules are independent of the provider's process and turn lifecycle.

`opencode_session_id` persists the native session identifier independently of other providers. The tracked Drizzle migration adds it automatically. Restored history uses stable message and tool IDs, reconciles concurrent stream updates, and reloads pending permission requests, forms, and child sessions. Stream reconnects reload snapshots to recover missed events.

Subscriptions are established before snapshot recovery because native events are live-only. Recovery publishes authoritative history and refreshes existing live items. Text and reasoning stream as incremental deltas. Turn completion fetches only the latest assistant response before one full reconciliation; repeated history reads use the cached transcript.

Full runtime recovery reloads descendant sessions and pending requests on startup and reconnect. Ordinary turn completion refreshes the root transcript without rescanning the descendant tree, keeping long conversations with many subagents responsive.

The frontend batches consecutive deltas into animation frames and flushes them before applying full parts or snapshots, preserving event order without duplicating recovered text. Queues also resume after a native execution recovered from a backend restart finishes; failed executions retain their error state.

Models and variants are discovered from each worktree's configuration. Project-only and local providers remain available independently of global credentials. OpenCode 2.x sessions restore their native model, variant, and primary agent after a backend restart. User-selected Elevenex model defaults apply to new sessions. Images use native file attachments and are checked against the model's declared input capabilities.

Selecting **Agent default** clears the explicit model and variant and resolves the current agent's configured model, falling back to the project default. Native v1 plan transitions, including `plan_exit`, update Elevenex's plan state. Interruptions pause a nonempty queue; clearing or cancelling its final prompt permits a fresh prompt immediately.

## Integrated features

- Streaming text, reasoning, tool calls/results, errors, context usage, and retries.
- Persistent history, exports, interruptions, queued prompts, and resumed sessions.
- Native forks, worktree moves, and conversation rewind that preserves working-tree files.
- Native permission requests with once/remember/deny responses and request ownership checks.
- Native questions and typed v2 forms, including numbers, booleans, multiselects, and browser links.
- Native plan agent, plan annotation/review, approval to implement, feedback, plan forks, plan Q&A, and inline review discussions.
- Project commands, `/agent <id>` for primary agents, native v2 skill activation, and `/compact`. Compaction and skill activation apply the current selection and mission instructions before execution.
- MCP status, enable/disable, rechecks, and browser authorization. Agent missions inject the authenticated Elevenex MCP server and their autonomy instructions through ephemeral configuration, preserving existing inline configuration.
- OpenCode-backed session titles, commit messages, worktree context, and speech cleanup. These use isolated temporary sessions with tool access denied, deadlines, and cleanup.

## Permission policies

| Elevenex selection           | OpenCode session policy                              |
| ---------------------------- | ---------------------------------------------------- |
| Ask for approval (`default`) | Preserve OpenCode project and agent permission rules |
| Automatic / Allow file edits | Allow file reads and edits; ask for other tools      |
| Unrestricted                 | Allow all tools in this session                      |

OpenCode permissions are tool policies; they do not add a filesystem sandbox. Plan mode selects OpenCode's native `plan` agent separately from the session permission policy.

## Protocol differences

OpenCode 2.x uses native mid-turn steering, typed form replies, explicit worktree moves, and staged history-only rewind. On 1.x, steering interrupts the current turn and resumes with the selected queued prompt, and rewind removes native messages without reverting files. Steering a prompt with images also uses interrupt/resume to preserve its attachments.

Elevenex does not expose OpenCode's standalone TUI as a terminal fallback. Provider-specific subscription quotas and a generic fast-mode toggle are not reported: native model variants remain available in the model controls. Plugin installation, advanced provider setup, custom form conditions, and native terminal commands remain configured through OpenCode itself.

## Validation

Run the focused backend specs with `pnpm --dir apps/backend exec jest --runInBand opencode`. After building the backend, run `node scripts/test-opencode-runtime.cjs` for an opt-in real CLI integration test. The script creates isolated temporary configuration and credentials, serves a fake model over loopback, and checks model discovery, model/variant reset, native agents, mission instructions, streaming, permission replies, tool execution, images, compaction, MCP configuration, restart recovery, history, forks, and file-preserving rewind. It uses no paid model. Set `OPENCODE_BINARY` to test another installed CLI version.

The implementation has been exercised with OpenCode 1.18.35 and 2.0.25. Both SDK versions are pinned in the lockfile.
