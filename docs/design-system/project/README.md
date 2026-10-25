Elevenex is an agent-first workspace: people start tasks, agents work in them, and the interface tells you at a glance what is running, what needs you, and what is ready to review. The look is cool glass: slate neutrals layered over a canvas, one teal accent, and calm, dense type. Build every screen from `tokens.json` and the components here; never hard-code a value the tokens name.

## The model, in the interface's words

- **Project**: a workspace holding one or more repositories, shown by its own logo or a face (two letters, an emoji or an icon, on its color). Work across all of them in **All projects** (⌘0), or open one project (⌘1–⌘9) to focus on it; **Focus mode** also mutes the other projects' badges until you leave it.
- **Task**: a unit of work you open, work on with agents, and **close** when it is finished. Each task has its own **branch** (named from the task, easy to rename, or an existing branch you pick) and a **workspace**: a ready checkout taken from the project's pool, chosen or set up for you. Say *task* for the work, *branch* for its git branch and *workspace* for where its files live; *worktree* appears only in Manage workspaces.
- **Stage**: where a task is in its life: Planned, In progress, Waiting, Closed. Many tasks live side by side in different stages.
- **Link**: a task may be linked to a pull request and/or a ticket, at creation or any time later, or to nothing at all. Links are optional and never nagged about.
- **Sub-task**: a short-lived branch off a task (or off another sub-task), with its own workspace and sessions, to tackle one thing (a bug, a spike) and merge right back into its parent. It's not a separate task: it lives in its parent's tree and has no stage of its own. Nor does it have a screen: like a task, it only groups sessions, and you only ever look at a session's chat. Above a session in a sub-task, the header names the sub-task and its parent (`TaskHeader parent`).
- **Session**: one agent conversation inside a task. A task holds many sessions.
- **Fork**: a new session copied from another at a chosen message, with full history; it can diverge and change files.
- **Side chat**: a short thread branched from one message to ask a follow-up; it is not added to the main session's context and does not edit files. It can be promoted to a fork.
- **Mention**: `@` a session, task or file in a message to hand its summary, outcome or contents to the agent.
- **Agent**: a harness (Claude Code, Codex, a local runner), a model, a thinking level and optionally fast mode. A **preset** saves that mix under a name; you pick one with a single click when a session starts. During a session the harness stays fixed (fork to change it); model, thinking and fast mode can still be adjusted.
- **Plan / Code**: Plan reads and proposes without editing; Code makes changes within the **permissions** (Ask first, Auto-edit, Full auto).
- **Machine**: where the engine (the backend that runs the agents) lives: **This Mac**, a **server** reached over SSH, or **another computer** running Elevenex that you paired with. Each window runs on one machine; open another window to work on two. Say *machine* in the interface; *engine* only where it matters (downloading, updating).
- **Queue / Steer**: a message sent while the agent runs waits in the queue for the turn to end; **steering** hands it to the agent at its next step without stopping it.

## Content fundamentals

- Voice: calm, brief, specific. The agent reports; the interface labels. No exclamation marks, no emoji, no “Oops”.
- Address the person as *you*; the agent speaks as *I* in its own messages only.
- Sentence case everywhere: buttons, tabs, menus, titles. Overlines (`overline`) are the only uppercase text.
- Lead buttons with a verb, one or two words: “New session”, “Commit”, “Push”, “Fork from here”, “Approve”.
- Name sessions by intent (“Reproduce flake locally”), never “Session 3”. Agents propose names; people can rename.
- Status words are fixed: Running, Needs you, Review, Done, Failed, Queued.
- Numbers over adjectives: “6 of 50 failed”, “+214 −38”, “2 to push”.

## Visual foundations

### Layers (the glass stack)

1. `canvas` fills the window. Regions float on it with `space-2` gutters; no full-bleed dividers.
2. `glass` for chrome that frames the work: the project rail and the sidebar. Always `backdrop-filter: blur(var(--blur-glass))` and `shadow-glass`, corners `radius-lg`.
3. `surface` for where the work happens: the main chat and the side panel, also `shadow-glass` and `radius-lg`.
4. `surface-raised` for things you act on inside a surface: the composer, the person's messages, the selected row, menus (`shadow-raised` or `shadow-pop`).
5. `surface-sunken` for wells: terminal, code, tool steps, hovered rows, tab tracks.

Separate with layers and gutters first, `line` hairlines second, and never with heavy borders. `line-strong` is for control outlines only.

### Color

- `accent` (Tide teal) is the only brand hue. It marks the primary action, selection, focus, links and running work. Use at most one `accent` fill per region.
- Text is `ink` or `ink-muted`; both hold 4.5:1 or more on canvas, glass and every surface in both themes. Put `accent`, `attention`, `review` and `danger` text only on the surfaces or their own `-soft` ground.
- Fills that carry text pair with their `on-` token: `on-accent` on `accent`, `on-project` on `project-*`.
- Project hues (`project-ocean` `pine` `plum` `rust` `steel` `rose`) identify projects that have no logo: monogram tiles and the switcher. Never use them for status or actions.

### Status (the core of the product)

| State | Token | Glyph | Means |
| --- | --- | --- | --- |
| Needs you | `attention` | diamond with a bang | blocked on a question, a permission or a decision |
| Running | `running` (= `accent`) | spinning ring | an agent is working |
| Review | `review` | half-filled circle | finished, with changes to look at |
| Done | `done` (= `ink-muted`) | check circle | finished, nothing to review |
| Failed | `danger` | filled cross | stopped on an error |
| Queued | `ink-muted` | dashed circle | waiting to start |

- Every status shows its glyph (`StatusGlyph`); color is never the only signal. Badges add the word.
- Loudness follows urgency: only *needs you* tints a whole row (`attention-soft`) and puts a count on a project tile. *Done* is deliberately quiet.
- Order is fixed wherever states are listed or counted: needs you, running, review, done.
- Diffs use `diff-add` and `diff-del` with their `-soft` line grounds, always with + and − signs; the changed words inside a changed line sit on `diff-add-strong` / `diff-del-strong`. Code in the changes view is colored with the small `code-*` palette (keyword, string, number, function, comment), checked at 4.5:1 on every surface and diff ground.

### Task stages and links

Sessions are circles, tasks are rounded squares: a task's stage never borrows a session glyph or a status color.

| Stage | Glyph (`StageGlyph`) | Means | Moves automatically when |
| --- | --- | --- | --- |
| Planned | dashed square | created, not started | saved from New task without starting |
| In progress | square with a bar | being worked on | a session starts |
| Waiting | square with a pause | parked: on review, CI, a person, or by choice | a PR is open and nothing runs |
| Closed | filled square with a check | finished and archived | you close it (a merged PR suggests it) |

- Stages are neutral (`ink`, `ink-muted` on `surface-sunken`); people can always change one from the `TaskStage` pill.
- Links show as `LinkChip`: the PR or ticket key in `mono-meta` with its live state. Only *checks failing* (`danger`) and *merged* (`accent`) take color; a merged PR turns Close task into a labelled button.
- Closing stops running sessions, archives the sessions and cleans up the task's files; unpushed work is called out first (`CloseTask`). Closed tasks can be reopened.
- A task with no links is complete as it is; “Link PR or ticket” stays a quiet ghost.

### Type

- Instrument Sans for the interface (`ui` for controls and rows, `body` for chat, `title` for the task header, `caption` for metadata, `overline` for sidebar section labels), Geist Mono for code and identifiers (`code`, `mono-meta`). Both load from Google Fonts.
- One `display` line per screen at most (empty states, the project title).
- Use tabular numerals for counts and diff stats; PR numbers (`#482`), ticket keys (`PAY-212`), branch names and commands always set in mono (`mono-meta`, `code`). Model and preset names stay in the interface face: they are names, not identifiers.

### Space, size and radius

- 4px base: `space-1` 4 · `space-2` 8 · `space-3` 12 · `space-4` 16 · `space-6` 24 · `space-8` 32.
- Shell sizes are tokens: `rail-width`, `sidebar-width`, `panel-width`, `chat-max`, `row-height` (32), `control-height` (30).
- Radii nest: a region at `radius-lg` holds rows and buttons at `radius-sm`, chips at `radius-xs`; cards and menus use `radius-md`; badges are `radius-full`.

### Layout: agent first, never cluttered

- At most four regions: project rail, sidebar, main chat, one side panel. No top app bar; ⌘K opens the command palette. Above them, the window's own title bar holds only the window controls and the island (`TitleBar`, `TitleIsland`), which names the window's machine.
- The rail switches scope: All projects on top, then each project. In All projects, task rows carry a small `ProjectMark`; inside one project they don't.
- The sidebar is an outline of tasks and their sessions (`TaskList`), built for many sessions per task:
  - **Two levels that never look alike.** A task is a 34px header row: its project's mark (in All projects), the title in 13.5 semibold, and its signal (the PR, branch and workspace live in the task header). A session is a lighter 28px row, 12.5 regular, under a thin guide line. The task header stays pinned while you scroll its sessions.
  - **Grouped by stage, in this order:** IN PROGRESS, WAITING, PLANNED, each counted. Waiting and Planned tasks start folded; closed tasks leave for the Closed list at the foot.
  - **Working sessions first, finished ones folded.** Needs you, running, to review and queued sessions are listed in the order they started; done ones fold into one “N finished” row per task. Forks and side chats sit at the same level, marked by their icon.
  - **Needs you is marked, never moved.** The session's glyph turns `attention` and its task shows “◆ 2”; tasks keep their place. No approvals or actions live in the sidebar: you answer in the session, with its context. To see only what needs you, the Needs you count in `StatusSummary` filters the list, and clearing it brings everything back.
  - **More sessions are one click away:** “+” on a task's header (on hover) starts a new one in that task.
- The task header (`TaskHeader`) has two rows: project mark, title, stage pill, then Close task and the panel toggle; below, the branch (`BranchChip`: click to rename, hover to copy), the links, a short meta and the `GitBar` (its one next step, or “Up to date”).
- New task (⌘N, or paste a ticket or PR link) opens `NewTask`, a small card you drive with the keyboard: **1 Name ↵ 2 Branch ↵ 3 From ↵**, shown as numbered rows that all stay visible (open step expanded, done steps checked, upcoming ones showing their default). Each step arrives with an answer highlighted (the branch from the name, the project's default base), so typing a name and pressing ↵ three times creates the task; ⌘↵ creates at any step, ⌥↵ saves as Planned. The footer shows no key hints: Save as planned on the left, and one main button that does what ↵ does, **Next ↵** until the last step, From, then **Create task ↵** (as in New project). An existing branch still goes on to From, which says it isn't needed. The branch step is one field that finds or creates (`BranchPicker`): matching branches below, **Create** on top when the name is new. Workspace (automatic) and Link (optional) are rows, not steps. The task opens on its first session at once while the workspace finishes setting up; there is no prompt field.
- **New project** (`NewProject`) is New task's shape for a project: **1 Repositories ↵ 2 Name ↵ 3 Look ↵**, under a head that says what it is, "dev-box / New project". Repositories is one box: the ones you've added as rows, then the field where you add one, which the machine answers folder by folder (nothing is scanned). The name starts as the first repository's; the look is letters, an emoji or an icon on one of six colors. The footer holds one button and no hints: **Next ↵** until Look, then **Create project ↵**. A machine with no project opens on this card alone, over the app out of focus; later, the rail's + opens it in a `ModalLayer`. Create sends the face home (see Motion) and opens the project on New task, never on a task named for you.
- Side views (Terminal, Code, Changes, Actions, Browser) share one panel, switched by `PanelTabs`; only one is open at a time and the panel closes to give the chat its full width.
- A new session opens on `SessionStart`: the task line (name, branch, workspace setup progress), “What should we work on?”, the presets as cards (one click or ⌥1–⌥9, the task's last preset preselected), and the composer. No menu stands between you and a preset. Forks and side chats skip it and inherit their parent's agent.
- The composer sits at the foot of the chat, no wider than `chat-max`, and holds every agent control (see below).
- The **Changes** side view is a pull-request-style review (`DiffReview`): every changed file in one scroll with a few lines around each change, more context on demand, files you mark Viewed, a file list to jump with, and Full files to read changes in their whole file. **Wider review** (the expand icon in the panel header, ⇧⌘R) lets the panel take over the chat's place for a while, with the file list in a column; Esc or the same icon brings the chat back. Lines load as files come near, behind skeletons sized from the counts.
- **Sub-tasks** start from where you are:
  - **Entry points:** a message or session (⋯ → Fix in a sub-task), the branch chip's menu (New sub-task from here), or ⇧⌘B.
  - **The name** comes from what you ask, and you can edit it.
  - **The base** is the parent branch's latest commit. Your uncommitted changes stay put unless you choose to bring them.
  - **In the sidebar,** they sit in the parent's tree at one indent, whatever their depth (`TaskGroup`). The mark steps down once per level (capped at three), the sub-tasks around the selected session light up, and hovering one lights its path and names it.
  - **The way back** is the git button: Merge into <parent> (`GitBar mergeInto`).
- **Several repositories in a project.** A project can hold several repositories; a task works in exactly one. With two or more, tasks carry a `RepoTag` in the sidebar and the header, and New task asks which one as step 2 (preselected). With one, nothing shows. Adding a repository is a setup step, never on the main path: in the project's ⋯ (Add a repository…) and in project settings.
- **The project's ⋯** (in the sidebar head, next to New task): Project settings… ⌘,, Add a repository…, Closed tasks; then Archive project (no confirm, Undo in a toast) and Delete project… (confirms what goes and what stays; the repositories on the machine are never touched). **Project settings** (`ProjectSettings`) is a `Sheet`: the project and its sections (General, Repositories, Tasks, Agents, Git) listed on the left, and every section in one scroll on the right, the face and name first. The list follows the scroll (its highlight glides to the section you're in) and a click scrolls there. Without room for the list (the sheet under 680px), the same scroll gets a sticky tab strip instead. A × closes it (Esc too): changes apply as you make them, so there's no Done or Save. Delete confirms with `DeleteProject`. The menu is `ProjectMenu`.
- **Git jobs.** Merging, syncing and pushing are jobs Elevenex runs itself, in three rungs:
  1. **Do it:** sync, rebase, regenerate lockfiles and generated files, run the project's checks, merge, clean up. No agent, no session. The git button shows the step (“Merging · 2 of 4”); its menu lists the steps with Cancel (`GitBar job`).
  2. **Start a session** when the job needs judgement (a real conflict, a check that breaks after syncing): one session for the job, where the work is (the sub-task), named for it, marked ⚡ (`SessionRow kind 'auto'`), on the project's light Git helper preset, opening on a `JobBrief` (what happened, what to do, when to stop). It's a normal session you can open and talk to, and it ends itself when the job's done. You aren't moved; a toast offers Open.
  3. **Ask you** only when that session can't decide: its row shows ◆, the task counts it, and the git button reads “Merge waiting on you”.
  - **Your sessions are yours.** Elevenex never posts in them, steers them or interrupts a turn, and no session speaks for a task. A merge changes the task's files only when it's safe: if a running session is editing the same files, the merge waits (a step in the menu).
  - **After a merge you stay where you were.** The sub-task's sessions now belong to the task (the header becomes the task's); messaging one carries on, on the task's branch. A toast says what merged, with Undo.
  - **Per project:** start helper sessions Automatically (default), Ask first (the toast has Start), or Never (the button opens the conflicts in Changes).
- Git is one button in the header (`GitBar`), the next step: **Commit 7** (files changed) while there are uncommitted changes, **Push 2** (commits waiting) once everything is committed, nothing but “Up to date” when there's nothing to do; the chevron holds the combinations (Commit and push, open a PR, sync). It never blocks a running agent.
- Session actions (side chat, fork from here, copy) appear on hover or keyboard focus of a message, not as permanent chrome; with a message focused, S opens a side chat, F forks, C copies.
- Each agent reply is a `Turn` (see *The chat* below). The agent's moments sit inline in the chat, in the order they happen: thinking and messages between steps (inside the turn's thread), `ToolStep` rows (grouped when consecutive), `StreamText` for the reply, and the *Needs you* cards: `ApprovalCard` (run, edit, tool), `QuestionCard` (one question or several in a row; pick one, pick any, or write your own answer as the last option) and `PlanCard` (start coding). Answered cards collapse to one line. When the agent writes below what you're reading, `NewMessagesPill` offers the jump.
- Waiting is never blank: `Skeleton` after 150ms for lists and messages, `ProgressLine` for workspace setup and pushes, and optimistic rows for anything you just created.
- Confirmations that may need reversing are a `Toast` with Undo; everything else confirms in place (a check, a collapsed card).

### The chat: what we show, how, and why

It reads like the chats people already use: **your messages are bubbles on the right; the agent's replies are on the left, its mark in a narrow 28px gutter**. Everything the agent says starts at one left edge, so the gutter alone tells you who is speaking. A reply always has the same anatomy, top to bottom: **work line → (thread) → answer → what it changed**.

The answer is what people came for; the work is the evidence. So a finished turn is quiet: **“Worked 4m 12s”**, the answer in full, then the files it changed. The facts behind the work line (“Edited 3 files +92 −12 · 200/200 passed · Ran 1 command”) fade in one by one when you hover or focus the reply, and stay while its thread is open. Unresolved failures never wait for a hover. On touch screens, where there is no hover, the facts are always shown.

The agent also talks while it works: it thinks, and it writes short messages between steps (“Reproduced: 6 of 50 runs time out, always while the mock is booting”). Those are the story of the turn, so the thread is built around them: **what the agent said is prose in ink; the steps under it are small muted rows.** Read only the prose and you know what happened; read the rows to check how.

Three levels, always in this order of prominence:
1. **Glance**: the work line, then its facts on hover (at most four: unresolved failures first, then files edited, the test result, commands run, files read). Enough to know *whether* to look.
2. **Thread** (`WorkTimeline`): the agent's messages, and one row per meaningful step under them, look-around steps grouped. A line runs down the gutter beside it, under the agent's mark.
3. **Detail**: a step's output, an edit's hunk, a group's file list, a thought's reasoning; inside the row, on demand.

| What happened | While live | Once finished | Why |
| --- | --- | --- | --- |
| Messages between steps (`say`) | Prose in the thread; the latest one always stays visible | In the thread, folded with it | It's the agent narrating its work; the answer is the conclusion |
| Thinking | `NowLine` “Thinking · <title>” with the last lines of the reasoning streaming, fading at the top | A row “Thought · <title> 9s”; the reasoning on click | Shows where its head is without making you read it |
| Reads, searches, listings | Grouped: “Read 3 files, searched 1 time” | Folded; “Read N files” only if room | Evidence, not news |
| Edits | Row with file and diff; hunk on click | Fact (files, +/−) and `FileChip`s under the answer | Changes are the deliverable |
| Commands, tests | Row with result; output on click; `NowLine` while running | Test result as a fact; commands counted | Verification builds trust |
| A failure it got past | Shown as it happens | Struck through, tagged “passed later” or “fixed”; not a fact | Once fixed it's history; keeping it red cries wolf |
| A failure on purpose (reproducing a bug) | Neutral, tagged “reproduced” | Neutral; not a fact | It's the plan working, not a problem |
| A failure it didn't get past | Row in `danger` | First fact, in `danger`, always visible; the turn may end *Failed after…* with Retry | You must know |
| Approvals, questions | *Needs you* card | One line, kept in place: “Approved · pnpm prisma migrate deploy” | Decisions are history worth reading |
| The answer | Streams, words un-blur in | Always in full, in every turn | It's the point |

- **Live, the thread keeps the latest thing the agent said and the last four steps.** Everything earlier folds into “N earlier steps” (never for a single row: folding one row saves nothing). The work line counts steps, not messages, and holds Stop.
- **Fold the work, never the words.** Answers and your messages are always shown in full, in every turn; only the steps fold away. No “Show more”.
- **Remember what a reply answers.** When a long reply pushes your message out of view, `ChatScroll` pins it at the top of the chat: “You asked”, its first two lines, Back to your message (scrolls there and rings it once) and Hide (for that message). It follows the exchange you're reading and leaves when the next message comes up. The pin is the only shortened copy of a message, and it's a reminder, not the message.
- **Say it in verbs.** “Ran `pnpm test`”, “Edited `payments/retry.ts`”: never raw tool names, JSON, or internal ids. A thought gets a short title (“Backoff or a longer delay”), not its first sentence.
- **Numbers over adjectives**, durations only above a second, mono for paths and commands.
- **Live is calm.** One `NowLine`, one shimmer, one breathing ring (on the agent's mark).
- **The fold is the reward.** When a turn finishes, the thread folds into the work line in place, the answer completes, and the changed files appear. Nothing jumps elsewhere.
- **Actions stay out of the way.** Side chat, fork and copy appear at the end of the reply's footer on hover or focus, beside Review; your message's time appears under its bubble on hover.
- **Long sessions get a map.** From five turns up, `TurnNav` at the chat's edge marks turns that changed files (`review`), need you (`attention`) or are live (`running`).

### Rich replies: Markdown and what it embeds

The agent writes Markdown and `Markdown` renders all of it, in full. One convention does the rest: **an image line embeds, a link links.** `![caption](path)` shows the file itself (a picture, a recording, or an HTML page, by its type); `[text](path)` is a link (a file in the task opens in Code, a web link in your browser).

- **Text stays chat-sized.** Headings are 17, 15, then 14px; spacing is compact; code blocks are bare wells whose language and Copy appear in the corner on hover (always on touch screens).
- **Pictures are figures in the answer.** One is as wide as the reply (at most 380px tall) with its caption. Two sit side by side; three or more become a strip. *Before* and *after* shots of one screen become a single picture you wipe across. Clicking opens the viewer, which grows from the picture and shrinks back into it.
- **Recordings get a player in the answer.** Poster at its size, one play button, nothing plays by itself; the track carries marks from the test's steps.
- **Pages are live, sandboxed, and as tall as they are.** Up to 480px; a longer page shows its top with **Show the whole page**. The bar has Phone width, Reload and Open in the Browser view. No network, no access to your files or to Elevenex.
- **Nothing jumps.** Every embed has its final size before it loads (from the file's width and height, or the page's reported height, eased). While the reply streams, an embed appears once its line is complete.
- **Only what's near the view stays alive.** Pages far out of view unload and reload when they come back; their space is kept.

### Side views: Browser and Terminal

- **The Browser is shared, the driver is one.** The agent opens tabs and drives the ones it opened. Its tabs carry its mark, which breathes while it acts; its cursor glides to each target with a ring and a label; a bar says the step. Your click or keystroke takes over at once, and Hand back returns it. When it needs you (sign-in, 2FA, payment), it stops, says "Your turn", and never sees password, card or code fields.
- **Point and ask** turns any element into a message with its source file and line. Errors in the page go to the agent with one click.
- **The Terminal is yours.** The agent's commands are tool calls in the chat and never show there. Tabs say what they're doing (running, serving on a port, failed, new output); + runs the project's scripts; a failed command is one click from Ask the agent.
- **Both belong to the task:** its workspace, branch and dev servers; they come back when you reopen it.

### The composer: every agent control, one row

One row of quiet controls under the input; everything else is one click deeper. Left: `ModeToggle` (Plan · Code), `AgentPicker` (shows the session's preset; adjusts model · thinking · fast; hidden on `SessionStart`, where the preset cards choose), `PermissionPicker` (hidden in Plan). Right: + `ToolsMenu` (attach files, mention, MCP servers), dictation, Stop while running, then Send (Queue while running).

| Do this | How |
| --- | --- |
| Send | ↵ (⇧↵ newline) |
| Queue while the agent runs | ↵; the message waits in `ComposerQueue` above the input |
| Steer (read now, no stop) | ⌥↵, or Steer on a queued message |
| Stop | ⌘. or the square button |
| Plan ↔ Code | ⇧Tab |
| Pick a preset (new session) | click a card, or ⌥1–⌥9 (⌘1–⌘9 stay for projects) |
| Adjust the agent | ⌘J |
| Mention a session, task or file | @ (opens `MentionMenu`) |
| Attach files | ⌘U, drop or paste |
| Dictate | ⌘D or the mic |

- Never add a button to the bar for a new capability; it goes into one of these menus.
- Icon controls carry no labels; tooltips give the name and shortcut.
- Chips that show a setting (agent, permission) are ghost buttons in `ink`; only the send button is filled.
- Fast mode adds a small `accent` bolt to the agent chip; there is no separate fast button. The chip also carries the `ContextMeter` ring, which turns `attention` at 75% and `danger` at 90%.

### Machines: where Elevenex runs

One machine per window. A window is always in one of three states, and they never mix:

- **Home**: no machine yet. New window (⇧⌘N) always opens here. Every machine is a card (`MachineHome`): **Connected** ones first with live status, then **Not connected** ones with what we knew last, dated. Home connects to nothing on its own.
- **Getting ready** happens on the machine's card on Home (`MachineCard`'s `busy`): connecting, installing, the engine downloading on first launch. The card says the step, a line along its foot fills, its dot breathes in `running`, and the island says it too. The machine opens only once it's ready, so the launch always opens onto the real app. Nothing from the machine shows before.
- **On a machine**: the app.

**Connections.** A server behind SSH is reached only when someone opens it. Every window on a machine shares one connection, and it lives only while a window uses it. One exception: a window that goes back to Home to change machine keeps its connection until you pick another, so changing your mind costs nothing. A paired computer opens without asking again; the computer that hosts shows who is connected, with Disconnect.

**Versions match.** The app only talks to an engine on its own version. When the app updates, the local engine updates at launch and a remote one the first time a window opens it, on its card like any getting ready. A window that's already on the machine has no card to wait on: it shows the update filling the window (`GettingReady`), and other windows keep working. If an engine is newer than the app (another computer's app updated it), the app asks to update itself.

**Connections heal themselves.** When the link to a machine drops, its sessions keep running there. The island turns amber and counts down to the next try (“dev-box · reconnecting in 3 s”), then says “Back online · nothing lost” and settles. The window stays readable meanwhile, and anything you type waits in the composer until it can send.

**The title island** (`TitleIsland`) names the window's machine at all times: its color dot, kind icon and name. It grows to tell machine news, one thing at a time (blocking states first: updating, connection lost; then events: someone connected; then the name), and shrinks back. Clicked, it opens the `MachinePanel`: the machine and Change on top, its connection and who else is on it, New window at the foot. Session news never goes there.

**Opening a machine** launches it like an app on a phone (`MachineLaunch`): the card grows into the window while its face fades and the machine's view scales up inside; Home zooms in and blurs behind. A machine that isn't ready gets ready on its card first and tags itself “Will open”; once ready, its dot settles, its line says so, and it launches a moment later. The last machine you asked for wins; Home stays usable meanwhile. Changing machine runs it backwards to Home, then forwards into the new one. It's two steps on purpose: changing a window's machine is rare, opening another window is the common move.

**First run** is Home's first-run look (`MachineHome` `firstRun`), so the first screen is the one you'll come back to. The title asks “Where should your agents run?”. This Mac is the first card, its engine downloading on it; next to it, “A server” and “Another computer” are dashed cards that add one (`MachineAdd`). Open This Mac while it gets ready and it opens once ready; whatever you open launches the way every machine will, onto `NewProject`. It stays the first-run look until a machine has been opened.

**Adding a machine** asks in a dialog over Home (`AddMachine` in a `ModalLayer` with `from`) that opens like a launch: its box grows out of the card or button you clicked, the card's face rides it and fades, the dialog scales up inside and Home recedes, on the launch's curve and time. Done, it runs backwards into the same place, where the new card now sits. A server reuses `~/.ssh/config` and the agent's keys (`HostField`), checks the host key once and pins it (`HostKeyCheck`), and installs into `~/.elevenex` without root. Pairing is a long text copied on one computer (`PairingText`) and pasted on the other (`PairPaste`), once. The dialog only asks: the new card gets ready on Home (other cards slide aside to make room, it grows in where it lands) and opens by itself once ready.

### States and motion

- Hover: `surface-sunken` under ghost items; selected: `surface-raised` + `shadow-raised`; pressed toggles: `accent` on `accent-soft`.
- Focus: `focus-ring` on every interactive element (2px surface gap, then 2px solid `accent`, 3:1 or more on every surface).
- Disabled: 45% opacity, no pointer events.
- Motion: see below.

### Motion

Motion explains change and never makes you wait. Timings and curves are tokens (`dur-instant` 80 · `dur-fast` 140 · `dur-base` 200 · `dur-slow` 280 · `dur-glide` 340 · `dur-deliberate` 420ms; `ease-out` to enter, `ease-in` to leave, `ease-glide` (a real spring, ≈4% overshoot) for anything that travels, `ease-spring` (≈12%) for small marks only). The springs are `linear()` curves sampled from a damped spring, so they settle naturally instead of snapping back. The `Motion` card shows each one live.

- **Never wait on motion.** Input is never blocked and every animation can be interrupted. Exits run at about two thirds of the entry time. Nothing a person waits on runs longer than `dur-slow`.
- **Small and close, a little playful.** Moves of 4–8px and a 0.94–0.97 scale; menus open from their anchor on the glide spring; presses go down instantly and spring back. Marks (counts, pips, checks, glyphs) may bounce; surfaces (cards, panels, dialogs) never do.
- **Alive while working, still when done.** Running work moves calmly (spinning ring, a light sweep across a running step, the blinking caret of streaming text, the thinking shimmer); finished things stop moving and a check draws itself once.
- **Only what changed.** History and first paint never animate. Lists put `ex-live` on their container after first paint, so rows, glyphs and messages that arrive later reveal; expanding a task staggers its sessions 24ms apart (six at most).
- **Things glide instead of jumping.** Segmented thumbs, side-view tabs and the project rail indicator spring to the new choice; when a tab's label opens, the other tabs slide aside (FLIP) and the label un-blurs in; the rail bar stretches as it travels; the keyboard highlight in pickers glides from row to row (only when the selection moves: when the list itself changes size, as a step opens, the highlight stays fitted to its row); counts and diff numbers roll; the context ring and progress lines ease to their new value.
- **Changes of state are felt, once.** A status glyph plays its change: finishing bursts a ring and draws the check, needing you nudges, failing shakes. Something you just created flashes once in its list. Your sent message springs up from the composer; streamed words un-blur in.
- **Nothing pops, nothing jumps.** Content never appears or disappears in a single frame, and nothing below it is shoved. Four tools cover every case:
  - `Fold` for anything that opens and closes in place (a thread, a step's output, a thought's reasoning, a task's sessions, a new-task step, a turn's footer, the now line): height eases between 0 and auto, with the content kept mounted. Closing is quicker than opening (`dur-base` vs `dur-slow`): the content lifts 4px and fades on `ease-in` first, then the box closes, so you never watch text being sliced by the bottom edge. Opening, the content settles from −4px and fades in 40ms after the box starts. It clips only while moving or closed, so focus rings and hover fills spill out once it has settled, and closed content can't be tabbed into.
  - `MotionList` for lists that change while you watch (the live thread): new rows grow in (height first, then ink), removed rows fade then collapse; rows are keyed by their first step, so a read that becomes “Read 3 files” updates in place.
  - `AutoHeight` for boxes whose content swaps or grows (a reply streaming, an approval collapsing to “Approved”, the new-task card turning into “Created”): the box eases to its new height over `dur-base`, follows small steps as they come, and never delays the content.
  - `Presence` / `usePresence` for things that leave (menus, toasts, queued messages): kept for an exit animation, without taking input.
- **The sidebar moves like one surface.** Inside `FlipScope`, a task that changes stage travels to its new group, the selection highlight glides from row to row (across tasks too), a finished session slides out of the working list while the “N finished” count rolls, new tasks and sessions grow in, a closed task fades and its space closes while the Closed count ticks. Nothing reorders because a status changed.
- **Bridge the gaps.** When one action ends and the next hasn't started, the now line holds for 700ms instead of collapsing and reopening (`useHold`). When a turn finishes, the work line crossfades to “Worked …”, the mark's ring lets go, the thread folds, and the footer opens, all at once and all eased.
- **Motion never changes layout.** A wrapper added for motion (a fold, a height box, a list row) must lay out exactly like what it wraps: it carries its parent's gap and direction, sizes its column `minmax(0, 1fr)` so long rows still truncate, and adds no gap when closed. Checked with the layout diff, which compares every text, input, button, menu and row box of each preview before and after a change.
- **Checked by measurement.** The motion probe samples, after every frame, where the content below a component sits and flags any one-frame shift. A full live turn (thinking, messages, tool calls, finish) moves content at most 6px per frame; before this pass it jumped up to 117px at once. The sidebar, through the eleven moments of the `TaskList` card (needs you, answer, new session, finish, filter, clear, a task to Waiting, a close), moves no visible row more than 35px in a frame, and only while a task glides a long way back after the filter clears; nothing jumps.
- **A new project jumps home.** On Create, everything starts together and is done in about a second: the card dissolves, and a copy of the face travels along one bell-shaped arc, up over the title bar and down into its tile in the rail, never up again (`jumpHome`). One curve times the whole flight (`cubic-bezier(0.4, 0, 0.2, 1)`); the copy grows towards the top (about 1.2×) and shrinks back to the tile, like a cartoon jump, its shadow following the height. As it lands the tile squashes and springs back and one ring in its color goes out (`settleMark`). The name follows on a lower arc into the sidebar, and the window comes into focus around them.
- **The island grows, it never jumps.** `TitleIsland` measures its new content and springs its width and height to it (`dur-deliberate`, `ease-spring`); the new content blurs in 60ms later. One pill, one change at a time.
- **Opening a machine is a launch.** `MachineLaunch` grows the card into the window (560ms open, 500ms close, one curve for the box, the face and the view), with Home zooming in around the card and blurring behind. The longest motion in the system, and the only one past `dur-deliberate`: it carries a change of place, a few times a day. Every launch, whatever the machine, follows the same rules:
  - **It starts from the card, where you see it.** The card's place on screen is read before anything else moves, so a card that's about to change group or reflow still launches from where it was. It never starts from the middle.
  - **Home holds still.** While a machine is open or opening, nothing on Home moves; a card getting ready or about to open keeps its place. Home catches up when it shows again, and the card lands back where it now is.
  - **Only a ready machine launches.** Getting ready happens on the card; when it's done, the dot settles and the line says so, and the launch starts about 450ms later, from a card at rest.
- **The reminder slides, it doesn't pop.** `ChatScroll`'s pinned message slides down 8px and fades in, leaves on `ease-in`, and its text blurs in when the exchange changes; on first paint it's simply there.
- **A control that changes its label stays the same element and eases its width.** Git's one button (Commit 7 → Committing… → Push 2 → gone) is never swapped for another: its icon and label crossfade in place (`EaseSwap`) while its width eases on `ease-in-out` (sizes never spring). It only grows in or closes when there's a step to show or none: the empty pill grows out from the right and its label fades in once there's room (closing is the reverse), so text is never cut by a hard edge; right-aligned controls give way into the space beside them, so nothing else in the row moves.
- **Opening context never moves what you're reading.** In `DiffReview`, lines opened above a hunk grow upward while the scroll follows, so the hunk stays put; lines opened below grow under where you were. Switching Changes ↔ Full files keeps the change you were reading at the same height. Marking a long file Viewed from inside it moves to its start under the stuck header before folding, so nothing jumps. Lines that load late arrive the same way: in view the skeleton eases to the real height, and above the view the scroll absorbs the change.
- **The review takes over the chat, it doesn't cover the window.** Wider review eases the Changes panel over the chat's place while the chat fades at its own width (no reflow); the rail and sidebar stay still. In and out are one motion: the review's file column and gutters open and close with the panel, never after it.
- **Modal surfaces recede the window.** A sheet or a confirm sits over the whole window, title bar included, and the window steps back: 98.5% scale, a 3px blur, a little less color, on the launch curve; it comes forward quicker on the way out (`ModalLayer`, `Sheet`, `useRecede`). Menus and popovers don't (they're anchored and light), and the machine launch and the lightbox keep their own motion.
- **Leaving is quicker than arriving.** Exits run on `ease-in` at about two thirds of the entry (`Presence` keeps an element mounted while it leaves, without taking input).
- **Optimistic first.** A created task, a sent message, an approval appear at once; skeletons only after 150ms, and replaced in place.
- **Change of place.** Switching session or project crossfades the main area with a 6px lift (View Transitions API); the side panel slides open and closed over `dur-slow`.
- **Cheap.** Animate transform and opacity only (plus the panel width); no layout-thrashing properties on hot paths.
- **Reduced motion means no movement.** Under `prefers-reduced-motion` all movement and loops stop and state changes apply at once; the shimmer becomes plain muted text.

### Motion decisions

The calls we made, and why, so the next person doesn't relitigate them.

- **Springs or easing curves for movement?** Springs. A cubic-bezier with overshoot (`back-out`) shoots past and snaps back in a fixed shape; a sampled spring decelerates into its overshoot and settles, which reads as physical rather than mechanical. Cost: `linear()` needs a recent engine; older ones fall back to plain ease, which is fine.
- **How bouncy?** Two levels only. ≈4% for things that travel (thumbs, indicators, menus) so it feels alive without wobbling; ≈12% for small marks so a count or a check has a little character. Zero for surfaces larger than a card: a bouncing panel feels like a toy and costs reading time.
- **Animate a tab's label by its width, or by moving the others?** Move the others (FLIP). Animating width re-lays out the row every frame and makes the thumb chase a moving target; with FLIP the layout changes once, everything slides from where it was, and the label un-blurs in 40ms later.
- **A highlight that follows the pointer across lists?** No, only the keyboard highlight glides. A pointer is faster than any animation, so a following highlight always lags; ↑↓ is where a glide helps you track the selection.
- **Celebrate when an agent finishes?** Only at the glyph: a ring burst and a drawn check, once. No confetti, no sound, no toast: finishing is frequent, and the sidebar already tells you.
- **Stream text letter by letter?** No. Text arrives in chunks and each chunk un-blurs in; a fake typewriter would slow reading down to the animation's pace.
- **Animate history and first paint?** Never. Opening a session with 200 messages should be instant; motion is for what changes while you watch.
- **Animate height, or just fade?** Height, with `grid-template-rows` (0fr ↔ 1fr) for folds and lists and a measured height for swaps. A fade alone leaves the content below jumping when the space appears or goes, and a jump is what people notice. Cost: layout runs during the move, which is fine for the few elements that move at once.
- **Ease or spring for heights?** Ease (`ease-in-out` for folds, `ease-out` for content that grows). A surface that overshoots its height bounces the text below it.
- **How does a machine open?** Like an app on a phone: the card grows into the window on one curve (`cubic-bezier(0.32, 0.72, 0, 1)`, 560 ms open, 500 ms close), and the face, the box and the view are keyframed together so they never drift. A plain zoom or crossfade loses where the window came from; a non-uniform scale of the view stretches it. This is the one motion longer than `dur-deliberate`: it happens a few times a day and carries a change of place.
- **How does a new project arrive?** It jumps home: one bell-shaped arc into the rail, the size growing then shrinking, and a squash and a ring as it lands. We tried a curve with a lift then a swing (read as two steps), and a throw that landed on a spring (it went up, down and up again). One curve for the whole path, with the bounce only in the tile's landing, reads as one gesture and shows where projects live. The tile may bounce: it's a mark; the card never does.
- **Page transitions?** Only the main area crossfades with a 6px lift when you switch session or project; the rail and sidebar never move, so your bearings stay put.

### Keyboard

One meaning per shortcut, everywhere. Check this table before giving anything a new one.

| Keys | Does |
| --- | --- |
| ⌘0, ⌘1–⌘9 | All projects, then each project |
| ⌘N | New task |
| ⇧⌘N | New window (opens on Home) |
| ⌘O | Find a machine (on Home) |
| ⌘K | Command palette |
| ⌘J | Adjust the agent |
| ⌥1–⌥9 | Pick a preset on a new session |
| ⇧Tab | Plan ↔ Code |
| ⌘U · ⌘D · ⌘. | Attach · dictate · stop |
| ↵ · ⌘↵ | Confirm or next · do it now (create the task at any step; open a machine in a new window) |
| ⌥↵ | Steer (in the composer) · save as Planned (in New task) |
| S · F · C | With a message focused: side chat · fork · copy |
| ← → · Esc | In the picture viewer: previous · next · close |
| ⌘T · ⇧⌘C | In the Browser or Terminal (focused): new tab · point and ask (Browser) |
| ⇧⌘B | New sub-task from where you are |
| ⇧⌘R | Wider review: the Changes panel takes over the chat (again, or Esc, to go back) |
| ⌥↑ · ⌥↓ · V · F7 | In the Changes review: previous · next file · mark viewed · next change (⇧F7 previous) |

### Shadows

- `shadow-glass` for regions, `shadow-raised` for items on a surface, `shadow-pop` for anything floating. Dark mode leans on the 1px top highlight in each.

## Iconography

- One line set on a 16px grid, 1.5px stroke, round caps and joins, `currentColor` (`Icon`). Use 16px in toolbars, 14–15px in rows and tabs, 13px for row-kind markers.
- Fixed meanings: `terminal`, `code`, `changes`, `actions`, `globe` (browser) for side views; `fork` and `side-chat` for branching a conversation; `branch`, `commit` and `push` for git; `workspace` for workspaces; `expand` / `shrink` for Wider review; `expand-up`, `expand-down` and `unfold` for opening context around a hunk; `wrap` for line wrapping; `folder` in file lists.
- The bundled set is original and small. For icons it lacks, use Lucide at the same 1.5 stroke; flag any mismatch rather than mixing styles.
- No emoji (except a project face someone picked), no filled icons, no provider logos: agent harnesses show a two-letter monogram on `accent-soft`; PRs and tickets show the `pr` / `merged` / `ticket` icons.
- Projects are the one place for outside imagery: each may carry its own logo (`ProjectMark`), shown as given, never recolored. Without one, the face is two letters, an emoji or an icon from the set, on the project's color. The sample logos in these previews are placeholders.
- There is no Elevenex logo yet: set “Elevenex” in Instrument Sans 600, `ink`.

## Components

Foundations: `Motion`, `Sheet` (and `ModalLayer`, `useRecede`), `Presence` (and `usePresence`), `Fold`, `AutoHeight`, `EaseSwap`, `MotionList` (and `useHold`), `FlipScope`, `Icon`, `Kbd`, `Switch`, `Segmented`. Actions: `Button`, `IconButton`, `GitBar`. Status: `StatusGlyph`, `StatusBadge`, `StatusSummary`. Projects: `ProjectRail`, `ProjectMark`, `NewProject` (and `projectFace`, `jumpHome`, `settleMark`), `ProjectMenu`, `ProjectSettings` (and `DeleteProject`). Tasks: `TaskGroup`, `TaskHeader`, `TaskStage` (and `StageGlyph`), `LinkChip`, `NewTask`, `BranchPicker`, `BranchChip`, `WorkspacePicker`, `TaskLine`, `CloseTask`. Navigation: `TaskList`, `SessionRow`, `PanelTabs`. Side views: `BrowserView`, `TerminalView` (and `ViewTabs`), plus `DiffReview` under Changes. Chat: `Turn` (and `TurnActs`), `Markdown`, `WorkTimeline`, `NowLine`, `OutcomeBar` (and `FileChip`), `TurnNav`, `ChatScroll`. Agent moments: `ApprovalCard`, `QuestionCard`, `PlanCard`, `JobBrief`, `ThinkingBlock`, `ToolStep`, `StreamText`. Feedback: `Toast`, `Tooltip`, `Skeleton`, `ContextMeter`, `NewMessagesPill`, `ProgressLine`. Conversation: `SessionStart`, `PresetPicker` (and `PresetCard`), `Composer`, `ModeToggle`, `AgentPicker`, `PermissionPicker`, `ToolsMenu`, `ComposerQueue`, `Mention`, `MentionMenu`, `Message`, `SideThread`. Changes: `DiffReview` (and `usePanelTakeover`), `ChangeList`. Machines: `MachineHome`, `MachineCard`, `MachineLaunch`, `GettingReady`, `TitleIsland` (and `TitleBar`, `IslandName`, `IslandEvent`), `MachinePanel`, `AddMachine` (and `MachineAdd`), `HostField`, `HostKeyCheck`, `PairingText`, `PairPaste`. Pages: `AppShell` shows them composed in the All projects view; `Chat` shows a conversation end to end, with a turn that runs and folds.

## Open questions and what isn't designed yet

Decisions still waiting on an answer. Until then, the system does what's in brackets.

1. Should *running* get its own color instead of sharing `accent` with buttons and selection? (It shares `accent`.)
2. In the branch step, when the typed name is new but close to an existing branch (“refund” vs `leo/refund-webhooks`), which goes on top? (**Create** stays on top.)
3. Should *Full auto* get a warning style in `PermissionPicker`? Is it right to have no read-only level because Plan covers it? (No warning; no read-only level.)
4. Should *In review* be a task stage of its own? (No: Waiting covers it.)
5. Does a pairing text expire, or work only once? (Not stated.)
6. On Home, ↵ on a machine already open in another window: bring that window forward, or open a second one? (↵ opens it here; ⌘↵ opens a new window.)
7. A machine's color: only the dot in the island, or also a light tint on the title bar? (Only the dot.)
8. Finished replies keep a footer row for their hover actions even when no files changed, which adds a little space under short replies. Keep it? (Kept.)
9. Shortcuts settled in the last audit to remove clashes: presets on a new session are ⌥1–⌥9 (⌘1–⌘9 are projects), New window is ⇧⌘N (⌘N is New task). Confirm.
10. Naming a task from its first message (an “Untitled task” that the agent names) was discussed and not built: New task names it up front.
11. Pictures from the web in a reply (`![…](https://…)`): load at once, or only after you allow that site, since loading tells the site you're reading? (`Markdown` shows whatever `resolve` returns; nothing asks yet.)
12. Short recordings (10s or less): loop silently like a moving screenshot, or always wait for Play? (They wait for Play.)

Not designed yet:
- Side views other than Changes, Browser and Terminal: Code, Actions.
- Browser features picked but not designed yet: compare with main or between forks, and the others from the views exploration (drawing on the page, responsive sweep, design overlay, record a flow into a test, open on your phone, visual changes in a turn, quick checks, emulation).
- In the Changes review: a side-by-side (split) view, asking about several lines at once, reverting a hunk, and whether the task header (title, branch, the git button) should stay visible during Wider review (for now it goes with the chat).
- The ⌘K command palette; Settings (presets, MCP servers, the workspace pool); Manage workspaces. (Project settings are designed: `ProjectSettings`.)
- Commit and PR beyond the `GitBar` menu: an agent-drafted commit message, “behind main” and sync, merge conflicts.
- Context menus (right click, ⋯) and the “Fork to…” harness chooser.
- In the chat: charts and interactive visuals the agent makes on the fly (today only an embedded HTML page), and how images you attach show in your own message (thumbnail, viewer).
- Empty states (no tasks, empty Planned, empty Closed; a machine with no project opens on `NewProject`), offline, a workspace that fails to set up, and in-progress buttons (“Creating…”, “Pushing…”).
- Narrow windows: what collapses first.
- Search inside a conversation, and “what changed since you last looked”.
- Machines: removing or editing a machine, why a connection failed (sign-in refused, host unreachable), and a machines section in Settings.
- A logo (the name is set in type), and shipping the fonts instead of loading them from Google Fonts.

How far things were checked: every card renders without errors and was looked at in light and dark. Motion was checked in the previews (layout diff, frame probe, frames paused mid-animation), never against a live agent's output.
