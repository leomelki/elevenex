# Conversation components

These standalone OnPush components consume renderer view models and emit typed intents. Import public components and types from `./index`. They never call the preload bridge, agents, filesystems, clipboard, or network services. Data wiring belongs to a feature container.

## Composition and ownership

- `ChatComponent` composes `ChatScroll`, user messages, turns, Markdown and turn navigation from `readonly ChatExchange[]`. Project a composer with `chatComposer`, and optional decision cards with `chatContent`.
- `TurnComponent` owns only expanded evidence and a 700ms current-step hold. Work and outcomes stay controlled inputs. Each `WorkStep.id`, exchange ID, queue ID and mention ID must remain stable across updates. Append updates instead of rebuilding transcript identities.
- `WorkTimeline` groups adjacent successful discovery steps. Failed work stays visible. It never infers that an unrelated later success fixed an earlier failure; set `recovered` explicitly.
- `ComposerComponent` owns the draft (`[(draft)]` is optional), mention query, local overlay state and file-drop feedback. It emits `ComposerSubmission` with `send`, `queue` or `steer`. Queue mutations, context additions/removals, recording and all agent settings are controlled by the owner. File attachment outputs contain user-selected browser `File` objects, which the integration must resolve through the permitted platform boundary.
- `AgentPicker.openPicker()` opens from a feature-owned action; `closePicker()` synchronously restores its opener before handing off to a modal such as PresetCreator.
- `AgentPicker` consumes supported harness/model/thinking capabilities, never inventing provider options. A session locks its harness by default. Unsupported thinking levels remain disabled.
- `QuestionCard` owns unfinished answers and navigation. Listed single choices answer immediately; multiple questions emit one answer map only when complete. Custom answers remain selected as they are edited. Pass `answers` to render a resolved result. `ApprovalCard` remains controlled and emits the exact resolution intent.
- `Chat.centerComposer` centers its existing composer region for an empty session, preserving the composer instance, draft and focus when the first turn starts. Keep it false when decisions or history need to be visible.
- `PresetPicker` accepts stable optional `AgentConfig.id` identities, display-only `modelLabel`/`harnessLabel`, controlled `value`, `disabled` and `compact`. `AgentConfig.default` adds a quiet Default label, independently of the selected ring. Without IDs it retains name/model selection compatibility. Option+1–9 uses physical digit keys so macOS Option characters work; selection stays within the supplied window. The owner supplies at most six starting choices. New cards enter after first paint, and the grid height eases through the shared AutoHeight owner.
- `PresetCreator` is a retained modal draft: provide a fixed `initial` agent and current `harnesses`, saved `names`, `open`, `busy`, `blocked`, `error` and thinking/fast capabilities. `defaultAvailable` adds a “Default for new chats” setting with Keep current / Use this preset choices (initially Keep current); `submitted.default` requests the persisted default. It emits `submitted(AgentConfig)` with a trimmed `preset` name, `closeRequested` and `closed`. With `harnessLocked=false` and a `catalogProvider(harnessId, signal, refresh?)`, the form offers a Harness dropdown and loads scoped, session-independent model capabilities on demand. Switching preserves a local draft per harness; failed reads are retryable, and closing/superseding a read aborts it and discards late results. Model controls and Create stay disabled until the chosen catalog is ready. The form edits harness/model/thinking/fast locally, checks duplicate names; it never saves on its own. Retain it through exit, deactivate children as closing begins and create a fresh identity for each draft. `ModalLayer` owns focus and recession; AutoHeight owns error-driven size changes.
- `SessionStart` selects the provided or first preset, offers task/branch rename intents, and accepts a projected composer. Workspace preparation never disables typing by itself. Readiness and deferred first-message delivery belong to the future session controller.
- `SideThread` is reusable panel content. When hosted in an overlay, set `trapFocus` to true and own dismissal through `closed`; the CDK restores focus to its originating element. The host owns popover placement. Promote is an intent, never a hidden fork operation.
- `JobBriefComponent` renders the supplied opening brief of a git-helper session. Inputs are `title`, `time`, and `id`; project the brief as text with inline `code`. It never inserts messages in sessions or starts a helper. The owner supplies what happened, what judgement is needed, and when to stop.

## Scrolling and performance

`ChatScroll` follows growth only while at the bottom, retains browser scroll anchoring while reading history, and shows a way back down. User messages expose `data-user-message` through `messageId`. The scroll owner finds the current prompt with a binary search, coalesces observations into animation frames, and refreshes its prompt index only when message elements change. Resize/mutation observers, scheduled frames and highlight animations are cleaned up on destruction. All message content remains readable in full; the reminder is the only clamped copy.

## Markdown and security

Markdown becomes a typed AST rendered as text nodes and semantic Angular templates. Raw HTML is always inert text. Active link schemes and credential-bearing URLs are rejected. File and web links emit separate intents; copying code emits `copyCode`. Mermaid fences remain code until a future trusted diagram adapter is supplied.

Local raster images have reserved dimensions and a keyboard-accessible native modal viewer. Grouped images provide a picture viewer with previous/next keyboard navigation. Before/after pairs have a keyboard-accessible comparison slider. Local recordings have playback, seek, speed, full-screen and timestamped step controls, and never autoplay. Assets are provided by a synchronous confined resolver, without platform calls from presentational components. `safeMediaSource` admits root-relative/app assets and supported raster data URLs; it rejects external resources, SVG data URLs and active schemes.

The production desktop forbids frame embedding and remote media. HTML documents therefore show a named page card and emit `openPage` for the Browser feature. `srcdoc` is never mounted or trusted. A future isolated page-preview adapter must preserve that desktop security boundary; the component does not weaken CSP or expose sandbox escape capabilities. Code highlighting is a text-only display lexer for JavaScript/TypeScript using the shared code palette. Code copy feedback is controlled through `copiedCode`, after the owner has handled the copy intent. Live page execution remains behind the future Browser adapter.

## Motion and accessibility

Components use the supplied design tokens, native controls, CDK overlays/focus traps and shared folds/height motion. Existing history renders without entry motion; `Message.isNew` explicitly opts a newly sent message into arrival motion. `StreamText` preserves existing chunks and animates only appended live content. Respect reduced motion throughout. Keyboard shortcuts are scoped to the composer, focused message, decision card or preset picker; there are no document-level listeners.

## Connected adapter and capability controls

The production [session chat adapter](../session-chat/README.md) owns transport,
selection, drafts, decisions and feedback. `Chat` accepts a `chatHistory` slot,
controlled `actions`, `stoppable`, `retryable`, and `copiedCode`. A
`ChatExchange.isNew` opts only fresh prompts into motion; `overflow` entries emit
`contentRequested` to the bounded original-content reader. Empty prompts support
partial history windows without inventing user text. `Turn` forwards the action
allowlist and retry capability, including keyboard shortcuts. Unknown duration
shows Worked/Working without an invented zero-second measurement.

`Composer.clearOnSubmit=false` lets a controlled owner clear the draft only after
accepting an intent, avoiding a child reset overtaking failure recovery.
`Composer.sending` disables submission/queue operations while keeping the draft
editable; `stoppable` controls stop availability. `showSettings`, `showTools`,
`showDictation` and `mentionsEnabled` default to true for existing consumers.
The `composerSettings` slot accepts integration-owned capability controls.
`queueEditable`/`queueReorderable` hide unsupported queue mutations.
`ComposerQueue` exposes the corresponding `editable`, `reorderable` and
`disabled` inputs. `ApprovalCard.disabled` guards decisions and shortcuts;
`allowAlways=false` omits unsupported permanent approval. `QuestionCard.disabled`
blocks submissions and disables its native answer fieldset while a reply is pending.

`ChatExchange.streaming` can control the reply cursor independently of a turn's
live tool activity; omitted values retain the status-based default for existing
consumers. Markdown gives the cursor to the current unfinished code block or to
prose, including nested lists/quotes. `NowLine.streaming=false` keeps a held
thinking line visible without keeping its cursor alive during the handoff to
assistant text.

`ChatExchange.answerBeforeStepId` (also accepted by `Turn`) places the latest
reply before that work step. Omit it when all work precedes the answer. Both
timeline sections follow the same work disclosure; individual tools retain
their output disclosures. This keeps commentary before tools that follow it,
including during streaming, while keeping the latest answer visible on collapse.
Only the last preceding running step uses `NowLine`; overlapping running tools
stay in their original timeline positions. Hover/focus facts include completed
edits, searches, listings, web requests and generic tools as well as reads and
commands, and remain available during live work.


## Connected composer controls

`Composer` keeps one toolbar row at narrow widths using its named `composer`
container. Thinking metadata, mode labels, then permission labels yield space;
accessible names remain. `settingsDisabled` prevents editing; `settingsBusy`
disables choices while keeping the agent popover mounted during reconciliation.
Neither locks the draft. `modeAvailable`, `agentLocked`, `showFork`,
`showSavePreset`, `reasoningAvailable`, `fastAvailable` and `canCompact` gate
operations supplied by the owner. `permissionChoices` accepts bounded,
harness-native IDs, labels and descriptions. Omission retains the design defaults.

### AgentPicker: reference and ownership

The standalone ZIP's `project/components/bundle.js` (`AgentPicker`, `UsageBlock`,
`UsageCard`, `PlanMeter`) and its CSS define the actual visual reference. The
[AgentPicker specification](../../../../../docs/design-system/project/components/AgentPicker/README.md)
and [usage specification](../../../../../docs/design-system/project/components/PlanMeter/README.md)
describe its interaction. A dedicated `/agent-picker` preview supplies identical
reference values, optional context/plan data, editable harnesses and busy states.

- `AgentPicker` owns the chip, 400ms pointer/focus disclosure, CDK portals,
  positioning, focus trapping/restoration and their lifetimes. It preserves
  `open` and `openPicker()` for the composer shortcut. Its settings portal stays
  mounted through exit, immediately becomes inert and releases its backdrop's
  pointer handling. Reopening interrupts that exit. Nested model-menu Escape
  closes that menu first. Focus initially reads the settings heading and returns
  to the opener on close. Harness, model, thinking and fast-mode changes keep
  the settings menu open so users can finish adjusting the agent.
  A compaction intent focuses stable content before its
  initiating button can disappear. When no settings are enabled, Tab/Shift Tab
  stay on the heading and Escape remains available through the whole owned pane.
- Internal `AgentSettings` owns capability-derived choices and controlled config
  intents. The source's fixed label column, harness mark/segment, compact model
  dropdown, thinking segment, fast switch/hint and separated footer are retained.
  Busy state keeps those controls and their data mounted. Unsupported thinking
  choices remain disabled. Provider-specific variants are appended using their
  exact IDs. An absent thinking value stays unselected rather than claiming Off.
- Internal `AgentUsage` renders the same context/plan block in the menu and the
  read-only hover card. Internal `AgentPlanMeter` shows the tighter account limit
  as a clock ring. `AgentConfig.tokens` is display text. Optional `plan` follows
  the supplied `{ win, week, resetWin, resetWeek, name, tier }` API: fractions are
  **remaining**, independently of the session's context fraction **used**.
  A supplied `windows` list takes precedence over that shorthand and carries
  actual provider IDs, labels, remaining fractions, optional `weekly`, `reset`
  and compact `resetShort` text. A weekly-only snapshot never invents a 5-hour
  allowance. Optional `exhausted` also reflects a provider-declared limit.
  Missing plan data is omitted. No account catalog, provider or transport reads
  originate in these components.
- Internal `PopoverPresence` retains the two portaled surfaces and their
  readonly data snapshots through their token-based exit and owns reduced-motion subscriptions/fallback timers. It
  exists because removing a CDK portal immediately would bypass child leave
  animation. The owner cancels hover timers, releases focus and lets CDK dispose
  its traps, portals and listeners on destruction. No component-family helper is
  added to the public barrel solely for this implementation.

`AgentConfig.thinking` and `AgentModel.thinking` accept provider-reported strings.
Model labels come from `AgentModel.label`. Settings emit a config intent, never a
platform operation. Fork, Save as preset and Compact emit their existing typed
intents only when enabled by the integrating owner. The connected session owner
supplies live context, token usage and provider-reported subscription limits.
`AgentUsageNotice` accepts `agent` and a session `identity`; it chooses one line
in order: exhausted plan, critical context, low plan, high context. Only the low
plan/high context lines can be dismissed; `dismissed` lets the owner restore focus.
It does not schedule prompts or change an agent's execution. Unimplemented platform actions
remain hidden there. Preview actions are local examples, outside the product graph.

The reference's content-box dimensions are translated explicitly to the renderer's
global border-box model: the standard menu is 368px overall (360px plus two 4px
insets), rows are 36px including padding, the label column is 84px, the footer is
24px, and the hover card is 288px overall. Under a constrained viewport the portal
stays confined, long choice tracks scroll horizontally, and the footer can wrap.
The original tokens remain authoritative. Menu entry uses `dur-glide/ease-glide`;
exit uses `dur-fast/ease-in`; reduced motion removes movement.

The locked CDK version treats numeric zero as an omitted pixel minimum. Popover
minimum dimensions use CSS `"0px"` strings so flexible connected positioning can
confine the source layout to a narrow viewport without a custom position engine.
Harness changes clear transient usage metadata; each harness owns its account and
context. Closing surfaces retain the prior snapshot until exit completes.
