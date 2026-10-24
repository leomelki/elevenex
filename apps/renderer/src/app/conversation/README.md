# Conversation components

These standalone OnPush components consume renderer view models and emit typed intents. Import public components and types from `./index`. They never call the preload bridge, agents, filesystems, clipboard, or network services. Data wiring belongs to a feature container.

## Composition and ownership

- `ChatComponent` composes `ChatScroll`, user messages, turns, Markdown and turn navigation from `readonly ChatExchange[]`. Project a composer with `chatComposer`, and optional decision cards with `chatContent`.
- `TurnComponent` owns only expanded evidence and a 700ms current-step hold. Work and outcomes stay controlled inputs. Each `WorkStep.id`, exchange ID, queue ID and mention ID must remain stable across updates. Append updates instead of rebuilding transcript identities.
- `WorkTimeline` groups adjacent successful discovery steps. Failed work stays visible. It never infers that an unrelated later success fixed an earlier failure; set `recovered` explicitly.
- `ComposerComponent` owns the draft (`[(draft)]` is optional), mention query, local overlay state and file-drop feedback. It emits `ComposerSubmission` with `send`, `queue` or `steer`. Queue mutations, context additions/removals, recording and all agent settings are controlled by the owner. File attachment outputs contain user-selected browser `File` objects, which the integration must resolve through the permitted platform boundary.
- `AgentPicker` consumes supported harness/model/thinking capabilities, never inventing provider options. A session locks its harness by default. Unsupported thinking levels remain disabled.
- `QuestionCard` owns unfinished answers and navigation. Listed single choices answer immediately; multiple questions emit one answer map only when complete. Custom answers remain selected as they are edited. Pass `answers` to render a resolved result. `ApprovalCard` remains controlled and emits the exact resolution intent.
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
