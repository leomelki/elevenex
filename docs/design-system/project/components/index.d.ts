import type * as React from 'react';

export type Status = 'running' | 'attention' | 'review' | 'done' | 'failed' | 'queued';
export type IconName = 'plus' | 'arrow-up' | 'terminal' | 'code' | 'changes' | 'actions' | 'globe' | 'fork' | 'side-chat' | 'chat' | 'check' | 'x' | 'chevron-down' | 'chevron-right' | 'at' | 'search' | 'commit' | 'push' | 'more' | 'stop' | 'sidebar' | 'panel' | 'attach' | 'repo' | 'task' | 'copy' | 'expand' | 'file' | 'pr' | 'merged' | 'ticket' | 'link' | 'archive' | 'layers' | 'focus' | 'clock' | 'mic' | 'bolt' | 'shield' | 'plug' | 'steer' | 'pencil' | 'trash' | 'plan' | 'branch' | 'workspace' | 'reset' | 'arrow-down' | 'bulb' | 'question';
export type ProjectHue = 'ocean' | 'pine' | 'plum' | 'rust' | 'steel' | 'rose';

export interface IconProps { name: IconName; size?: number; className?: string }
export declare function Icon(props: IconProps): React.ReactElement;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  icon?: IconName;
  iconRight?: IconName;
  kbd?: string;
}
export declare function Button(props: ButtonProps): React.ReactElement;

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required: accessible name and tooltip. */
  label: string;
  /** Present = a toggle; true = pressed. */
  active?: boolean;
  size?: 'md' | 'sm';
}
export declare function IconButton(props: IconButtonProps): React.ReactElement;

export interface KbdProps { children: React.ReactNode }
export declare function Kbd(props: KbdProps): React.ReactElement;

export interface StatusGlyphProps { status: Status; size?: number }
export declare function StatusGlyph(props: StatusGlyphProps): React.ReactElement;

export interface StatusBadgeProps { status: Status; label?: string }
export declare function StatusBadge(props: StatusBadgeProps): React.ReactElement;

export interface StatusSummaryProps {
  counts: { attention?: number; running?: number; review?: number; done?: number };
  active?: 'attention' | 'running' | 'review' | 'done';
  onSelect?: (status: 'attention' | 'running' | 'review' | 'done') => void;
}
export declare function StatusSummary(props: StatusSummaryProps): React.ReactElement;

export interface ProjectMarkProps {
  name: string;
  /** Image URL of the project's own logo (square, 72px or more). Falls back to the monogram. */
  logo?: string;
  /** Two letters, on the hue. */
  initials?: string;
  /** A face picked by the person: one emoji, on the hue (wins over icon and initials). */
  emoji?: string;
  /** A face picked by the person: an icon name from the set, on the hue (wins over initials). */
  icon?: string;
  hue?: ProjectHue;
  /** 36 rail, 20 headers, 16–18 rows and pickers. */
  size?: number;
  /** True when the name is written next to the mark. */
  decorative?: boolean;
}
export declare function ProjectMark(props: ProjectMarkProps): React.ReactElement;

export interface Project extends ProjectMarkProps {
  id: string;
  attention?: number;
  running?: number;
  /** Focus mode: dims the tile and hides its counts. */
  muted?: boolean;
}
export interface ProjectRailProps {
  projects: Project[];
  /** Totals for the All projects tile, or false to hide it. */
  all?: { attention?: number; running?: number; muted?: boolean } | false;
  /** 'all' or a project id. */
  activeId?: string;
  onSelect?: (id: string) => void;
  /** The + tile; hands back the tile, for ModalLayer's `from`. A project added to `projects` later pops into its place. */
  onAdd?: (tile: HTMLElement) => void;
  className?: string;
}
export declare function ProjectRail(props: ProjectRailProps): React.ReactElement;

export type Stage = 'planned' | 'active' | 'waiting' | 'closed';
export interface StageGlyphProps { stage: Stage; size?: number }
export declare function StageGlyph(props: StageGlyphProps): React.ReactElement;
export interface TaskStageProps { stage: Stage }
export declare function TaskStage(props: TaskStageProps): React.ReactElement;

export interface LinkChipProps {
  kind: 'pr' | 'ticket';
  /** '#482', 'PAY-212'. */
  label: string;
  /** PR: draft | open | approved | failing | merged | closed. Ticket: the tracker's status text. */
  state?: 'draft' | 'open' | 'approved' | 'failing' | 'merged' | 'closed' | string;
  href?: string;
  /** Key only, for sidebar rows. */
  compact?: boolean;
}
export declare function LinkChip(props: LinkChipProps): React.ReactElement;

export interface Repo { id?: string; name: string; /** what tags show; defaults to the name */ short?: string; hue?: ProjectHue; path?: string; base?: string }
/** Which repository a task works in: its short tag (else its name), quiet, cut when long; `md` adds the repo icon. */
export declare function RepoTag(props: { repo: Repo | string; size?: 'sm' | 'md' }): React.ReactElement;
/** Modal surfaces: over the whole window; the window recedes (98.5%, blur, dim) while they're open. */
export declare function useRecede(on: boolean, ref?: React.RefObject<HTMLElement>): void;
export interface ModalLayerProps { open: boolean; onClose?: () => void; align?: 'center' | 'top'; /** The element it opened from: the dialog opens like a machine launch out of it (box, face, content on the launch curve) and closes back into the same place. */ from?: HTMLElement | null; className?: string; children?: React.ReactNode }
export declare function ModalLayer(props: ModalLayerProps): React.ReactElement | null;
export interface SheetSection { id: string; label: string; icon?: string; /** a count after the label in the list (e.g. repositories) */ count?: number; content: React.ReactNode }
export interface SheetProps { open: boolean; onClose?: () => void; label?: string; className?: string;
  /** The sections, laid out as one scroll: listed on the left (tabs when the sheet is under 680px), each in turn on the right under its label. */
  sections?: SheetSection[];
  /** Where the scroll starts when it opens (default: the first section). */
  section?: string;
  /** Above the list (e.g. the project's mark and name). */
  navHead?: React.ReactNode;
  /** At the top of the scroll, before the first section (e.g. the face and the name). */
  hero?: React.ReactNode;
  /** Without sections: your own list, and a body that `page` cross-fades when it changes. */
  nav?: React.ReactNode; page?: string; children?: React.ReactNode }
export declare function Sheet(props: SheetProps): React.ReactElement | null;
export declare function SetGroup(props: { title?: string; note?: React.ReactNode; children?: React.ReactNode }): React.ReactElement;
export declare function SetRow(props: { label: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }): React.ReactElement;
export declare function SetField(props: { value?: string; placeholder?: string; mono?: boolean; wide?: boolean; label?: string }): React.ReactElement;
/** A value that reads as text. Hover or focus shows a soft fill and a pencil; click it and it becomes the field in the same
 *  place. ↵ or leaving keeps the change (`onChange`), Esc puts it back. `onInput` follows each keystroke (for a live preview). */
export declare function SetValue(props: { value?: string; placeholder?: string; label: string; mono?: boolean; well?: boolean; prompt?: boolean; /** Looks like a field from the start: a box with a pencil. */ field?: boolean; className?: string; onInput?: (v: string) => void; onChange?: (v: string) => void }): React.ReactElement;
export interface ProjectMenuProps { project: ProjectMarkProps; repoCount?: number; machine?: string; closed?: number; onSettings?: () => void; onAddRepo?: () => void; onClosed?: () => void; onArchive?: () => void; onDelete?: () => void }
export declare function ProjectMenu(props: ProjectMenuProps): React.ReactElement;
export interface ProjectSettingsProps { open: boolean; onClose?: () => void; project: ProjectMarkProps & { look?: 'letters' | 'emoji' | 'icon' }; repos?: (Repo & { setup?: string; check?: string; tasks?: number; sync?: string })[]; machine?: string;
  /** Where the scroll starts when it opens (⌘, opens on General; Add a repository… on Repositories). */
  section?: 'general' | 'repos' | 'tasks' | 'agents' | 'git'; openRepo?: string; adding?: boolean; addQuery?: string; listFolders?: (q: string) => { path: string; git?: string | null }[];
  prefix?: string; since?: string; helpers?: 'auto' | 'ask' | 'never'; onChange?: (p: Partial<ProjectMarkProps> & { look?: string }) => void; onRepoChange?: (r: Repo, patch: { short?: string; setup?: string; check?: string }) => void; onAddRepo?: (f: { path: string; git?: string | null }) => void; onRemoveRepo?: (r: Repo) => void; onArchive?: () => void; onDelete?: () => void }
export declare function ProjectSettings(props: ProjectSettingsProps): React.ReactElement | null;
export declare function DeleteProject(props: { project: ProjectMarkProps; tasks?: number; sessions?: number; running?: number; machine?: string; onCancel?: () => void; onArchive?: () => void; onDelete?: () => void }): React.ReactElement;
/** A folder the machine answers with as you type a path in New project. */
export interface FolderEntry { path: string; name?: string; /** what to show for a git folder, e.g. 'main · 214 commits'; null: not a repository yet */ git?: string | null; branch?: string; /** a folder you can go into */ dir?: boolean; /** a URL to clone into ~/code */ clone?: string }
export interface NewProjectRepo { id: string; name: string; path: string; branch?: string | null; clone?: string | null }
export interface NewProjectResult { name: string; repos: NewProjectRepo[]; look: 'letters' | 'emoji' | 'icon'; emoji?: string; icon?: string; hue: ProjectHue }
export interface NewProjectProps {
  /** The machine's name, shown in the head: "dev-box / New project". */
  machine?: string;
  machineIcon?: string;
  /** The folders in the folder being typed (one level), git ones with their branch. */
  listFolders?: (query: string) => FolderEntry[];
  /** ↵ on Look, Create project, or ⌘↵. Gets the project and the card element (find [data-np="face"] and [data-np="name"] there to fly them). Without it, the card shows a demo "Created" line. */
  onCreate?: (project: NewProjectResult, card: HTMLElement) => void;
  /** Esc; also shows Esc in the head. Leave it out on the first run. */
  onCancel?: () => void;
  autoFocus?: boolean;
  /** A state to start from. */
  repos?: NewProjectRepo[]; name?: string; look?: 'letters' | 'emoji' | 'icon'; emoji?: string; icon?: string; hue?: ProjectHue;
  step?: 'repos' | 'name' | 'look'; query?: string; listOpen?: boolean;
}
/** 1 Repositories ↵ 2 Name ↵ 3 Look ↵, in New task's rows; one button: Next ↵, then Create project ↵. */
export declare function NewProject(props: NewProjectProps): React.ReactElement;
/** ProjectMark props for a project being made: letters, emoji or icon on its hue (or one from the name). */
export declare function projectFace(face: { name: string; look?: 'letters' | 'emoji' | 'icon'; emoji?: string; icon?: string; hue?: ProjectHue | null }): ProjectMarkProps;
export interface JumpHomeOptions {
  /** The highest the copy's top edge goes, as a y in root (default 4: over the title bar). */
  peak?: number;
  /** How much bigger the copy gets at the top of the arc (default 0.4; 0.06 for a name). */
  grow?: number;
  /** Size at landing relative to the copy; default: the target's width over the source's. */
  scale?: number;
  /** For a text field: the text that travels. */
  text?: string;
  shadow?: boolean; dur?: number; delay?: number; ny?: number;
  /** Runs as the copy hands over to the target (also at once under reduced motion). */
  landed?: (target: HTMLElement) => void;
}
/** One bell-shaped jump of a copy of `from` onto `to` (both inside `root`), on one curve, growing then shrinking. */
export declare function jumpHome(root: HTMLElement, from: HTMLElement, to: HTMLElement, options?: JumpHomeOptions): Animation | null;
/** The tile it landed on squashes and springs back, and one ring in its color goes out. */
export declare function settleMark(root: HTMLElement, el: HTMLElement, hue?: ProjectHue): void;
export interface TaskHeaderProps {
  /** In a project with several repositories: the task's. */
  repo?: Repo;
  title: string;
  stage: Stage;
  branch?: string;
  links?: LinkChipProps[];
  meta?: string;
  project?: ProjectMarkProps;
  git?: GitBarProps;
  /** The linked PR merged or the work looks finished: Close task becomes a labelled button. */
  closeSuggested?: boolean;
  panelOpen?: boolean;
  /** On a sub-task: its parent (the task or another sub-task), named above the title. */
  parent?: { title: string; branch?: string; onOpen?: () => void };
}
export declare function TaskHeader(props: TaskHeaderProps): React.ReactElement;

export interface CloseTaskProps { title: string; sessions: number; running?: number; unpushed?: number; ticket?: string }
export declare function CloseTask(props: CloseTaskProps): React.ReactElement;

export interface BranchInfo { name: string; when?: string; remote?: boolean; /** Held by this task: shown, not pickable. */ task?: string; /** The project's default base. */ isDefault?: boolean }
export interface Workspace { name: string; state: 'free' | 'used'; note?: string; task?: string }
export interface NewTaskProps {
  project: ProjectMarkProps;
  /** The project's repositories; with two or more, Repository is step 2 (preselected: `repo`). */
  repos?: Repo[]; repo?: string; onAddRepo?: () => void;
  /** Branches of a given repository, when they differ. */
  branchesFor?: (repoId: string) => BranchInfo[];
  /** Every branch the project knows; `task` marks one another task holds. */
  branches: BranchInfo[];
  /** Branches offered in From; defaults to the free ones. */
  bases?: BranchInfo[];
  /** The project's default base, highlighted in From. */
  base?: string;
  /** Prefix for inferred branch names, from project settings (e.g. 'leo/'). */
  branchPrefix?: string;
  title?: string;
  /** Show a given state. */
  step?: 'name' | 'branch' | 'base';
  /** Text in the branch field; absent = follows the task name. */
  branchQuery?: string;
  baseQuery?: string;
  /** Highlighted row in the open list. */
  hi?: number;
  /** 'auto' or a workspace name. */
  workspace?: string;
  workspaces?: Workspace[];
  workspaceOpen?: boolean;
  links?: LinkChipProps[];
  autoFocus?: boolean;
  /** ↵ on the last step, ⌘↵ anywhere, or the button. Without it the card shows a demo “Created” line. */
  onCreate?: (task: { title: string; branch: string; existing: boolean; base: string | null }) => void;
  /** ⌥↵: save as Planned. */
  onPlan?: (task: { title: string; branch?: string; base?: string }) => void;
  /** Esc. */
  onCancel?: () => void;
}
export declare function NewTask(props: NewTaskProps): React.ReactElement;
export interface BranchRow { kind: 'create' | 'branch' | 'invalid'; name: string; when?: string; remote?: boolean; task?: string; isDefault?: boolean }
export interface BranchPickerProps { query: string; branches?: BranchInfo[]; items?: BranchRow[]; allowCreate?: boolean; base?: string; hi?: number; onPick?: (row: BranchRow) => void; label?: string }
export declare function BranchPicker(props: BranchPickerProps): React.ReactElement;
/** Rows for a query: matches (every word must appear), newest/default first; a Create row on top when allowCreate and the name is new. */
export declare function branchItems(query: string, branches: BranchInfo[], allowCreate?: boolean): BranchRow[];
export interface BranchChipProps { name: string; base?: string; compact?: boolean }
export declare function BranchChip(props: BranchChipProps): React.ReactElement;
export interface WorkspacePickerProps { value?: string; items?: Workspace[]; open?: boolean }
export declare function WorkspacePicker(props: WorkspacePickerProps): React.ReactElement;
export interface TaskLineProps { task: { project?: ProjectMarkProps; title: string; branch?: string; base?: string; workspace?: { state: 'setup' | 'ready'; step?: string } } }
export declare function TaskLine(props: TaskLineProps): React.ReactElement;
/** 'Rate-limit refunds', 'leo/' → 'leo/rate-limit-refunds' (lowercase, hyphens, ≤48 chars). */
export declare function branchFromTitle(title: string, prefix?: string): string;

export interface SessionRowProps {
  title: string;
  status: Status;
  /** auto: a session Elevenex started for a git job (⚡) */
  kind?: 'main' | 'fork' | 'side' | 'auto';
  diff?: { add: number; del: number };
  meta?: string;
  selected?: boolean;
  unread?: boolean;
  /** Indent steps (16px each). */
  depth?: number;
  /** Position in its list, for the reveal stagger. */
  index?: number;
  /** Just created: flashes once. */
  fresh?: boolean;
  onClick?: () => void;
}
export declare function SessionRow(props: SessionRowProps): React.ReactElement;

export interface TaskSession extends SessionRowProps {
  /** Stable id: motion (moves, the selection glide) follows it. */
  id: string;
}
export interface TaskGroupProps {
  /** Stable id: the task travels when it changes stage. */
  id?: string;
  title: string;
  /** In a project with several repositories: the task's, shown as a RepoTag after the title. */
  repo?: Repo | string;
  sessions: TaskSession[];
  /** The task's PR or ticket (the PR wins); shown in the row only with showLink (the task header always shows it). */
  link?: LinkChipProps;
  showLink?: boolean;
  links?: LinkChipProps[];
  /** Shown in the all-projects view. */
  project?: ProjectMarkProps | null;
  /** `waiting` and `planned` start folded. */
  stage?: 'active' | 'waiting' | 'planned';
  /** The selected session's id. */
  selected?: string;
  /** Show only sessions with this status (and fold away the finished ones). */
  filter?: Status | null;
  collapsed?: boolean;
  /** “+” on the header: a new session in this task. False hides it. */
  onAdd?: (() => void) | false;
  /** Just created: its header flashes once. */
  fresh?: boolean;
  /** Arrive open, then fold (set by TaskList when a task moves into a folded stage). */
  startOpen?: boolean;
  /** Sub-tasks: short-lived branches off this task (or off another sub-task: `parent`), each with its own workspace and sessions. Any depth, one indent. */
  subtasks?: SubTask[];
  /** “+” on a sub-task: a new session in it. */
  onAddSub?: (sub: SubTask) => void;
}
export interface SubTask {
  id: string; title: string; branch?: string;
  /** another sub-task's id; empty when it branches off the task */ parent?: string | null;
  sessions?: TaskSession[];
  /** committed and checked: ready to merge into its parent */ ready?: boolean;
  /** merged back: it leaves the tree for the task's finished row */ merged?: boolean; diff?: { add: number; del: number };
}
export declare function TaskGroup(props: TaskGroupProps): React.ReactElement;
export interface TaskListProps {
  tasks: Array<TaskGroupProps & { id: string }>;
  /** The selected session's id; the highlight glides to it. */
  selected?: string;
  /** A status (usually 'attention', from StatusSummary): everything else folds away. */
  filter?: Status | null;
  /** False inside one project's view: no project marks. */
  showProjects?: boolean;
  onAdd?: (task: TaskGroupProps) => void;
  className?: string;
}
/** The sidebar's body: tasks by stage (In progress, Waiting, Planned), each group counted; moves between stages travel. */
export declare function TaskList(props: TaskListProps): React.ReactElement;
export interface FlipScopeProps { /** data-flip key of the selected element: its highlight glides there. */ selected?: string; as?: string; className?: string; style?: React.CSSProperties; children?: React.ReactNode }
/** Anything inside marked data-flip="key" glides from where it was to where it is after a change, across lists too. */
export declare function FlipScope(props: FlipScopeProps): React.ReactElement;

export interface PanelTab { id: string; label: string; icon: IconName; badge?: boolean }
export interface PanelTabsProps { tabs: PanelTab[]; active: string; onSelect?: (id: string) => void; labelled?: boolean; label?: string }
export declare function PanelTabs(props: PanelTabsProps): React.ReactElement;

export type Thinking = 'Off' | 'Low' | 'Medium' | 'High' | 'Max';
export interface AgentConfig {
  /** A saved preset's name, when this config is one. */
  preset?: string;
  /** Two-letter harness monogram. */
  mark: string;
  harness: string;
  model: string;
  thinking?: Thinking;
  fast?: boolean;
  /** Share of the context window used, 0–1; shows a ContextMeter in the chip. */
  context?: number;
}
export interface AgentPickerProps {
  value?: AgentConfig;
  open?: boolean;
  placement?: 'top' | 'bottom';
  /** Harness fixed for the running session (default true); 'Fork to…' switches it. */
  locked?: boolean;
  harnesses?: string[];
}
export declare function AgentPicker(props: AgentPickerProps): React.ReactElement;

export interface PresetCardProps { preset?: AgentConfig; selected?: boolean; kbd?: string; custom?: boolean; onSelect?: () => void }
export declare function PresetCard(props: PresetCardProps): React.ReactElement;
export interface PresetPickerProps {
  presets: AgentConfig[];
  /** Selected preset name, or 'custom'. */
  value?: string;
  onSelect?: (preset: string) => void;
  /** Pills instead of cards (NewTask). */
  compact?: boolean;
  /** False hides the Custom card. */
  custom?: boolean;
}
export declare function PresetPicker(props: PresetPickerProps): React.ReactElement;
export interface SessionStartProps {
  presets: AgentConfig[];
  /** Preset selected at first: the last used in this task, else the first. */
  value?: string;
  /** Task line: name, branch and workspace setup. */
  task?: TaskLineProps['task'];
  context?: React.ReactNode;
  title?: string;
  composer?: ComposerProps;
}
export declare function SessionStart(props: SessionStartProps): React.ReactElement;

export interface ModeToggleProps { value: 'plan' | 'code'; onChange?: (mode: 'plan' | 'code') => void }
export declare function ModeToggle(props: ModeToggleProps): React.ReactElement;

export type Permission = 'ask' | 'edits' | 'auto';
export interface PermissionPickerProps { value: Permission; open?: boolean }
export declare function PermissionPicker(props: PermissionPickerProps): React.ReactElement;

export interface McpServer { name: string; tools?: number; on?: boolean; error?: string }
export interface ToolsMenuProps { servers?: McpServer[]; open?: boolean }
export declare function ToolsMenu(props: ToolsMenuProps): React.ReactElement;

export interface ComposerQueueProps { items: Array<{ text: string }> }
export declare function ComposerQueue(props: ComposerQueueProps): React.ReactElement;

export interface SwitchProps { on: boolean; label: string; onChange?: (on: boolean) => void }
export declare function Switch(props: SwitchProps): React.ReactElement;

export interface SegmentedOption { id: string; label?: string; icon?: IconName; title?: string }
export interface SegmentedProps { options: SegmentedOption[]; value: string; onChange?: (id: string) => void; size?: 'md' | 'sm'; label?: string; className?: string }
export declare function Segmented(props: SegmentedProps): React.ReactElement;

export interface MentionProps { kind?: 'session' | 'task' | 'file'; status?: Status; removable?: boolean; children: React.ReactNode }
export declare function Mention(props: MentionProps): React.ReactElement;

export interface ComposerProps {
  mode?: 'plan' | 'code';
  agent?: AgentConfig;
  /** Hide the agent chip (SessionStart, where preset cards choose it). */
  hideAgent?: boolean;
  permission?: Permission;
  servers?: McpServer[];
  /** Attached files and mentions, shown as removable chips. */
  context?: Array<{ kind: 'session' | 'task' | 'file'; status?: Status; label: string }>;
  queue?: Array<{ text: string }>;
  /** Shows Stop; Send becomes Queue when there is text. */
  running?: boolean;
  /** Files are being dragged over: the edge breathes and the box says “Drop to attach”. */
  dropping?: boolean;
  /** Dictation in progress. */
  recording?: { time?: string; interim?: string } | false;
  placeholder?: string;
  hasText?: boolean;
  agentOpen?: boolean;
  permissionOpen?: boolean;
  toolsOpen?: boolean;
  className?: string;
  children?: React.ReactNode;
}
export declare function Composer(props: ComposerProps): React.ReactElement;

export interface MessageProps { /** A message you just sent: springs up from the composer. */ isNew?: boolean; /** Lets ChatScroll's reminder follow this message (user messages). */ id?: string; role: 'user' | 'agent'; author?: string; mark?: string; /** User: shown under the bubble on hover. Agent: in the mark's tooltip. */ time?: string; sideChats?: number; pinned?: boolean; children: React.ReactNode }
export declare function Message(props: MessageProps): React.ReactElement;

export interface SideThreadProps { title?: string; anchor?: React.ReactNode; className?: string; children?: React.ReactNode }
export declare function SideThread(props: SideThreadProps): React.ReactElement;

export interface GitBarProps { /** uncommitted changed files */ files: number; add?: number; del?: number; /** commits not pushed yet */ ahead?: number; /** while it runs */ busy?: 'commit' | 'push' | 'merge'; onCommit?: () => void; onPush?: () => void; /** on a sub-task: the parent branch; the next step after committing is Merge into it */ mergeInto?: string; onMerge?: () => void; compact?: boolean }
export interface GitJobStep { status: Status; label: string; detail?: string; /** what the button says while this step runs */ short?: string; /** the session Elevenex started for this step */ session?: string }
export interface GitJob { verb?: string; noun?: string; title?: string; steps: GitJobStep[]; /** the session it started needs you */ waiting?: boolean; /** menu open (previews) */ open?: boolean; note?: string; onOpen?: () => void; onCancel?: () => void }
export interface GitBarProps { /** a job Elevenex runs (merge, sync, push): the button shows its step, its menu the steps */ job?: GitJob }
export declare function GitBar(props: GitBarProps): React.ReactElement;

export interface ChangeItem { path: string; status: 'M' | 'A' | 'D' | 'R'; add?: number; del?: number; /** the file you're on (`selected` also works) */ current?: boolean; selected?: boolean; viewed?: boolean; /** changed since you viewed it */ changed?: boolean }
export interface ChangeListProps { items: ChangeItem[]; /** files under their folder */ grouped?: boolean; onSelect?: (path: string) => void }
export type EmbedFile =
  | { kind: 'image'; src: string; w: number; h: number }
  | { kind: 'video'; src?: string; poster?: string; w: number; h: number; dur: number; marks?: { t: number; label: string }[] }
  | { kind: 'page'; title?: string; srcdoc?: string; url?: string; h?: number };
export interface MarkdownProps {
  /** what the agent wrote */ source: string;
  /** what an embedded file is (![caption](path)); nothing when it doesn't exist */ resolve?: (path: string) => EmbedFile | null | undefined;
  onOpenFile?: (path: string) => void; onOpenLink?: (url: string) => void; onOpenPage?: (path: string) => void;
  /** draws a mermaid block; without it the block shows as code */ renderDiagram?: (source: string) => React.ReactNode;
  /** the text is still arriving */ streaming?: boolean; className?: string;
}
/** The agent's reply, fully rendered: text blocks, code, tables, callouts, and embedded pictures, recordings and live sandboxed pages. */
export declare function Markdown(props: MarkdownProps): React.ReactElement;
export interface BrowserTab { id: string; title: string; url?: string; /** the task's dev server serving it */ server?: string; /** 'agent' for tabs the agent opened */ by?: 'agent' | 'you'; color?: string }
export interface BrowserViewProps {
  tabs: BrowserTab[]; active?: string; onSelect?: (id: string) => void; onClose?: (id: string) => void; onNew?: () => void;
  /** who drives the active tab */ driver?: 'agent' | 'you' | 'needs'; onTakeOver?: () => void; onHandBack?: () => void; agentWaiting?: boolean;
  step?: { n: number; total?: number; text: string }; /** the element the agent acts on, in page coordinates */ action?: { x: number; y: number; w: number; h: number; label?: string };
  picking?: boolean; onPick?: () => void; picked?: { x: number; y: number; w: number; h: number; label: string; file?: string }; onAsk?: (text: string) => void;
  errors?: number; errorText?: string; onSendErrors?: () => void; width?: 'full' | 'phone'; onWidth?: () => void;
  needsTitle?: string; needsText?: string; onBack?: () => void; onReload?: () => void; children?: React.ReactNode; className?: string; style?: React.CSSProperties;
}
/** The Browser side view, shared by the agent and you: tabs, one driver per tab, the agent's cursor and steps, take over and hand back, hand-offs for secrets, point and ask, errors to the agent. */
export declare function BrowserView(props: BrowserViewProps): React.ReactElement;
export interface TerminalTab { id: string; title: string; cmd?: string; status?: 'idle' | 'running' | 'serving' | 'failed'; port?: number; cwd?: string; branch?: string; unread?: boolean }
export interface TerminalViewProps {
  tabs: TerminalTab[]; active?: string; onSelect?: (id: string) => void; onClose?: (id: string) => void; onNew?: () => void;
  scripts?: { name: string; cmd: string }[]; onRun?: (script: { name: string; cmd: string }) => void;
  /** preview output: [kind, text] with kind cmd | dim | ok | err | warn | info; in the app pass the terminal as children */ output?: [string, string][];
  failure?: { code: number; cmd: string } | null; onAsk?: () => void; onRerun?: () => void; onOpenPort?: (port: number) => void; onStop?: () => void;
  children?: React.ReactNode; className?: string; style?: React.CSSProperties;
}
/** The Terminal side view: your shells in the task's workspace (never the agent's commands), tabs that show what they're doing, scripts, ports, and a failed command one click from the agent. */
export declare function TerminalView(props: TerminalViewProps): React.ReactElement;
/** The tab row both side views use: tabs grow in and close away. */
export declare function ViewTabs(props: { items: { id: string; title: string; tip?: string }[]; active?: string; onSelect?: (id: string) => void; onClose?: (id: string) => void; onNew?: () => void; newLabel?: string; lead?: (t: any) => React.ReactNode; trail?: (t: any) => React.ReactNode; after?: React.ReactNode; label?: string }): React.ReactElement;
export interface DiffFile { path: string; status: 'M' | 'A' | 'D' | 'R'; /** line counts, known before the lines load (git numstat) */ add?: number; del?: number; /** bump when the file changes: its lines are fetched again */ rev?: number; /** the file before, if already known (omit for added files) */ old?: string; /** the file now, if already known (omit for deleted files) */ new?: string; oldPath?: string; binary?: boolean; viewed?: boolean; changedSinceViewed?: boolean }
export interface DiffReviewProps {
  files: DiffFile[];
  /** fetch a file's two versions when it comes near the view */ loadFile?: (path: string) => Promise<{ old?: string; new?: string }>;
  mode?: 'changes' | 'full'; onMode?: (mode: 'changes' | 'full') => void;
  /** two gutters and the file column; otherwise decided by width (720px and up) */ wide?: boolean;
  wrap?: boolean; context?: number; largeAt?: number;
  onViewed?: (path: string, viewed: boolean) => void;
  /** a line question for the agent; false hides the line + */ onComment?: ((c: { path: string; line: number; side: 'old' | 'new'; text: string }) => void) | false;
  onOpenFile?: (path: string) => void;
  /** Esc with nothing open (leaves the wider review) */ onExit?: () => void;
  /** gets { goTo(path), step(dir) } */ controller?: { current: { goTo(path: string): void; step(dir: 1 | -1): void } | null };
  toolbarEnd?: React.ReactNode;
  className?: string; style?: React.CSSProperties;
}
/** The Changes view, reviewed like a pull request: every changed file in one scroll, hunks with context you can open, files you mark Viewed, a file list to jump with, and Full files to read each change in its whole file. */
export declare function DiffReview(props: DiffReviewProps): React.ReactElement;
/** The Changes panel takes over the chat for a while: returns the ref for the main area; the shell gets `is-takeover`. */
export declare function usePanelTakeover(on: boolean): React.RefObject<HTMLElement>;
/** The line diff DiffReview uses: [{ t: ' ' | '-' | '+', o, n, s }] with removed lines before added ones in each change. */
export declare function diffLines(a: string[], b: string[]): { t: ' ' | '-' | '+'; o: number | null; n: number | null; s: string }[];
export declare function ChangeList(props: ChangeListProps): React.ReactElement;

/* ── Agent moments ── */
export type ApprovalStatus = 'pending' | 'approved' | 'always' | 'denied';
export interface ApprovalCardProps { kind?: 'command' | 'edit' | 'tool'; command?: string; file?: string; diff?: { add: number; del: number }; tool?: string; reason?: string; where?: string; status?: ApprovalStatus; onResolve?: (s: ApprovalStatus) => void; onUndo?: false | (() => void) }
export declare function ApprovalCard(props: ApprovalCardProps): React.ReactElement;
export interface QuestionOption { label: string; detail?: string; recommended?: boolean }
export interface Question { id?: string; /** short name for the step strip, e.g. "Retry policy" */ header?: string; question: string; /** single: pick one (radio) · multi: pick any (checkboxes) */ kind?: 'single' | 'multi'; options: QuestionOption[] }
export interface QuestionCardProps {
  /** One question: question + options (+ kind). Several in a row: questions. */
  question?: string; options?: QuestionOption[]; kind?: 'single' | 'multi'; header?: string;
  questions?: Question[];
  /** Show it answered: answer (one question) or answers ({ [id]: labels }). */
  answer?: string | string[]; answers?: Record<string, string[]>;
  onSubmit?: (answers: Record<string, string[]>) => void;
}
export declare function QuestionCard(props: QuestionCardProps): React.ReactElement;
export interface PlanCardProps { title?: string; steps: Array<{ text: string; state?: 'todo' | 'running' | 'done' }>; status?: 'proposed' | 'running' | 'done'; onStart?: () => void }
export declare function PlanCard(props: PlanCardProps): React.ReactElement;
export interface ThinkingBlockProps { active?: boolean; seconds?: number; open?: boolean; children?: React.ReactNode }
export declare function ThinkingBlock(props: ThinkingBlockProps): React.ReactElement;
export interface ToolStepProps { icon?: IconName; verb?: string; detail: string; status?: 'running' | 'done' | 'failed'; meta?: string; output?: string; open?: boolean }
export declare function ToolStep(props: ToolStepProps): React.ReactElement;
export interface StreamTextProps { text: string; streaming?: boolean; /** Types the text out, for previews. */ demo?: boolean; speed?: number; run?: number }
export declare function StreamText(props: StreamTextProps): React.ReactElement;
export interface MentionMenuProps { query?: string; sessions?: Array<{ label: string; status?: Status; meta?: string }>; tasks?: Array<{ label: string; stage?: Stage; meta?: string }>; files?: Array<{ label: string; meta?: string }>; hi?: number; inline?: boolean }
export declare function MentionMenu(props: MentionMenuProps): React.ReactElement;

/* ── Feedback ── */
export interface ToastProps { title: string; detail?: string; action?: string; tone?: 'danger'; glyph?: Status; /** ms; 0 keeps it. */ duration?: number; onAction?: () => void; onClose?: () => void }
export declare function Toast(props: ToastProps): React.ReactElement;
export interface TooltipProps { label: string; kbd?: string; side?: 'top' | 'bottom' }
export declare function Tooltip(props: TooltipProps): React.ReactElement;
/** The sub-task mark: a staircase with one step per level (1 = a sub-task of the task), capped at three, in a 16px slot. */
/** The first message of a session Elevenex started for a git job. */
export interface JobBriefProps { title?: string; time?: string; id?: string; children?: React.ReactNode }
export declare function JobBrief(props: JobBriefProps): React.ReactElement;
export interface SubtaskGlyphProps { depth?: 1 | 2 | 3 | number; className?: string }
export declare function SubtaskGlyph(props: SubtaskGlyphProps): React.ReactElement;
export interface SkeletonProps { variant?: 'rows' | 'message'; count?: number }
export declare function Skeleton(props: SkeletonProps): React.ReactElement;
export interface ContextMeterProps { used: number; tokens?: string; compact?: boolean }
export declare function ContextMeter(props: ContextMeterProps): React.ReactElement;
export interface NewMessagesPillProps { count?: number }
export declare function NewMessagesPill(props: NewMessagesPillProps): React.ReactElement;
export interface ProgressLineProps { /** 0–1; absent = indeterminate. */ value?: number }
export declare function ProgressLine(props: ProgressLineProps): React.ReactElement;
/* ── Agent turns ── */
export type StepKind = 'think' | 'read' | 'search' | 'list' | 'edit' | 'create' | 'run' | 'test' | 'tool' | 'web' | 'ask' | 'say' | 'note';
export interface Step {
  kind: StepKind;
  /** Path, command, query or tool target (mono). */
  detail?: string;
  /** Overrides the default verb (Ran, Edited…); live steps use the -ing form (Running, Testing…). */
  verb?: string;
  status?: 'running' | 'done' | 'failed';
  /** Result text: '6 of 50 failed', '143 / 200'. */
  meta?: string;
  /** Test result shown as a fact: '200/200 passed'. */
  result?: string;
  /** Shown only over a second: '48s'. */
  dur?: string;
  diff?: { add: number; del: number };
  output?: string;
  /** Diff lines prefixed with '+', '-' or ' '. */
  hunk?: string[];
  /** A failure the agent got past: true or a short reason ('fixed by backoff'). Inferred when a later run/test passes. */
  recovered?: boolean | string;
  /** A failure caused on purpose (reproducing a bug): true or a short reason. */
  expected?: boolean | string;
  /** kind 'say' (or the older 'note'): what the agent writes between steps, shown as prose in the thread.
   *  kind 'think': the reasoning, shown on click (finished) or streaming in the NowLine (live). */
  text?: string;
  /** kind 'think': a short title for the thought ('Backoff or a longer delay'). */
  title?: string;
  /** Live thinking: type the text out (demos). */
  stream?: boolean;
  /** Live only. */
  progress?: number;
  elapsed?: number;
  open?: boolean;
}
export interface TurnProps {
  status?: 'live' | 'done' | 'stopped' | 'failed';
  steps?: Step[];
  /** Seconds the turn took (finished). */
  duration?: number;
  /** Seconds so far (live). */
  elapsed?: number;
  outcome?: OutcomeBarProps;
  error?: string;
  /** Start unfolded. */
  open?: boolean;
  /** Thread rows visible while live (default 4). */
  maxVisible?: number;
  /** Shown as the agent mark's tooltip with the time. */
  author?: string; mark?: string; time?: string;
  /** Live: the Stop chip on the work line. Pass false to hide it. */
  onStop?: (() => void) | false;
  children?: React.ReactNode;
}
export declare function Turn(props: TurnProps): React.ReactElement;
/** Side chat, fork, copy: icon buttons shown on hover or focus of a reply. */
export declare function TurnActs(): React.ReactElement;
export declare function isSay(step: Step): boolean;
export interface WorkTimelineProps { steps: Step[]; live?: boolean; maxVisible?: number }
export declare function WorkTimeline(props: WorkTimelineProps): React.ReactElement;
export interface NowLineProps { kind?: StepKind; verb?: string; detail?: string; /** Thinking: the thought's title. */ title?: string; /** Thinking: the reasoning, last lines shown. */ text?: string; stream?: boolean; meta?: string; elapsed?: number; progress?: number }
export declare function NowLine(props: NowLineProps): React.ReactElement;
export interface FileChipProps { path: string; add?: number; del?: number; status?: 'M' | 'A' | 'D'; index?: number }
export declare function FileChip(props: FileChipProps): React.ReactElement;
export interface OutcomeBarProps { files: FileChipProps[]; action?: string; actionIcon?: IconName; max?: number }
export declare function OutcomeBar(props: OutcomeBarProps): React.ReactElement;
export interface TurnNavProps { turns: Array<{ id: string; label: string; meta?: string; state?: 'changes' | 'attention' | 'live' }>; active?: string }
export declare function TurnNav(props: TurnNavProps): React.ReactElement;
export interface FoldProps { open: boolean; className?: string; children: React.ReactNode }
export declare function Fold(props: FoldProps): React.ReactElement;
export interface AutoHeightProps { /** ms the box keeps its explicit height after the last change (default 240). */ duration?: number; className?: string; innerClassName?: string; children: React.ReactNode }
/** A box that eases to its content's height: swaps and jumps ease over dur-base; small steps are followed as they come. */
export declare function AutoHeight(props: AutoHeightProps): React.ReactElement;
export interface MotionListProps { items: Array<{ key: string; node: React.ReactNode }>; as?: string; itemAs?: string; className?: string; role?: string; /** Leave duration in ms (default 300; matches dur-slow plus a frame). */ exit?: number }
/** A keyed list whose new rows grow in and removed rows collapse out. */
export declare function MotionList(props: MotionListProps): React.ReactElement;
/** { m: mounted, l: leaving } — keeps an element for `exit` ms after `show` turns false. */
export declare function usePresence(show: boolean, exit?: number): { m: boolean; l: boolean };
/** The last non-empty value, held for `ms` after it empties (bridges gaps between two actions). */
export declare function useHold<T>(value: T | null | undefined, ms?: number): { value: T | null | undefined; on: boolean };
/** Consecutive reads, searches and thinking become one group row. */
export declare function groupSteps(steps: Step[]): Array<Step | { kind: 'group'; label: string; items: Step[]; status: 'running' | 'done' }>;
/** Marks failures superseded by a later passing run/test as recovered. */
export declare function settle(steps: Step[]): Step[];
/** Up to four facts for the work line, most important first. */
export declare function summarize(steps: Step[]): Array<{ text: string; icon: IconName; tone?: 'ok' | 'danger'; diff?: { add: number; del: number } }>;
/** 252 → '4m 12s'. */
export declare function fmtDur(seconds: number): string;

export interface PresenceProps { show: boolean; /** ms, default 160 */ exit?: number; children: React.ReactNode }
/** Keeps a child mounted while it plays its exit (.is-leaving). */
export declare function Presence(props: PresenceProps): React.ReactElement | null;
/** Web Animations with the system's spring tokens; no-op under reduced motion. */
export declare function play(el: Element | null, frames: Keyframe[], opts?: { ease?: string; dur?: string }): Animation | null;
/** A number that rolls up or down when it changes. */
export declare function Ticker(props: { value: number }): React.ReactElement;

/* ── Small parts used across components ── */
export interface DiffProps { add?: number; del?: number }
/** Line counts, +added in diff-add and −removed in diff-del; numbers roll when they change. Renders nothing when both are 0. */
export declare function Diff(props: DiffProps): React.ReactElement | null;
export interface WorkspaceStatusProps { state?: 'setup' | 'ready'; step?: string }
/** “Setting up workspace · installing deps” (running ring) or “Workspace ready” (check), in a task line. */
export declare function WorkspaceStatus(props: WorkspaceStatusProps): React.ReactElement;
export interface WaveformProps { levels?: number[] }
/** The dictation level bars in the composer while recording. */
export declare function Waveform(props: WaveformProps): React.ReactElement;

/** Labels for each status, as shown in badges and tooltips. */
export declare const STATUS: Record<'running' | 'attention' | 'review' | 'done' | 'failed' | 'queued', string>;
/** Labels for each task stage. */
export declare const STAGE: Record<'planned' | 'active' | 'waiting' | 'closed', string>;
/** Thinking levels, in order. */
export declare const THINKING: Array<'Off' | 'Low' | 'Medium' | 'High' | 'Max'>;
/** Permission modes: id, full label, short label for the chip, one-line note. */
export declare const PERMS: Array<{ id: 'ask' | 'edits' | 'auto'; label: string; short: string; note: string }>;

/* ── Machines: where Elevenex runs ── */
export type MachineKind = 'local' | 'ssh' | 'peer';
/** live: connected · kept: its window is picking another machine · idle: not connected (we show what we knew last) · fail: the last try failed */
export type MachineConn = 'live' | 'kept' | 'idle' | 'fail';
export interface Machine { id: string; name: string; kind: MachineKind; conn: MachineConn; address?: string; status?: string; last?: string; color?: string; windows?: number; /** the version it had, when it's behind the app */ update?: string;
  /** Getting ready (connecting, installing, updating, the engine downloading): the card says the step, a line along its foot fills. It opens once this is gone. */
  busy?: { step: string; progress?: number; meta?: string };
  /** Getting ready failed: what failed in one short line, the tone ('warn' for couldn't, 'danger' only for safety, like a changed host key), where the bar stopped, and the action (default 'Try again'). */
  error?: { step: string; tone?: 'warn' | 'danger'; progress?: number; action?: string };
  /** For editing: its color name (the card's `color` is var(--project-<hue>)), and for a server where and how to reach it. */
  hue?: 'ocean' | 'pine' | 'plum' | 'rust' | 'steel' | 'rose'; host?: string; user?: string; port?: number | string; key?: string; paired?: string }
export interface TitleIslandProps { contentKey?: string; tone?: 'rest' | 'info' | 'warn' | 'ok'; tall?: boolean; open?: boolean; progress?: number; onClick?: () => void; className?: string; children?: React.ReactNode }
/** The title-bar pill: names the window's machine, grows to tell machine news, opens into MachinePanel. */
export declare function TitleIsland(props: TitleIslandProps): React.ReactElement;
/** The window's title bar: controls on the left, the island centered. Window chrome, not an app bar. */
export declare function TitleBar(props: { className?: string; children?: React.ReactNode }): React.ReactElement;
/** The island's resting content. `back`: on Home after Change, "Back to dev-box" (clicking the island opens it again). */
export declare function IslandName(props: { machine: Machine; guests?: number; back?: boolean }): React.ReactElement;
export declare function IslandEvent(props: { icon?: string; title: string; sub?: string; action?: string; onAction?: () => void }): React.ReactElement;
export interface MachinePanelProps { machine: Machine; guests?: Array<{ name: string; since: string }>; highlight?: 'change' | 'new'; onChange?: () => void; onDisconnect?: () => void; onDisconnectGuest?: (g: { name: string; since: string }) => void; onNewWindow?: () => void }
export declare function MachinePanel(props: MachinePanelProps): React.ReactElement;
/** One machine on Home. `pending`: it was opened while getting ready, so it opens by itself once ready ("Will open"). */
export declare function MachineCard(props: { machine: Machine; highlighted?: boolean; pressed?: boolean; pending?: boolean; onOpen?: (m: Machine) => void; /** A failed card's action (Try again); falls back to onOpen. */ onAction?: (m: Machine) => void;
  /** Its ⋯ (on hover or focus, in the tag's place) and right-click: where to open MachineMenu. `card` is for ModalLayer's `from`. */
  onMenu?: (m: Machine, at: { x: number; y: number; card: HTMLElement; fromButton?: boolean }) => void; menuOpen?: boolean; /** Collapsing out (removed). */ leaving?: boolean }): React.ReactElement;
/** An empty, dashed card that adds a machine (Home's first run). Hands back the card, for ModalLayer's `from`. */
export declare function MachineAdd(props: { kind: 'ssh' | 'peer'; onClick?: (card: HTMLElement) => void }): React.ReactElement;
export interface MachineHomeProps { machines: Machine[]; highlighted?: string; pressed?: string;
  /** Machines opened while getting ready: they open by themselves once ready. */
  pending?: string | string[];
  /** The first run (until a machine has been opened): the question as the title, one grid, and A server / Another computer as cards. */
  firstRun?: boolean;
  /** The island points at a card: { id, at }; each new `at` scrolls to it and rings it once. */
  ping?: { id: string; at: number } | null;
  /** The Find pill (⌘O), also what a click on the resting island opens. */
  onFind?: () => void; findOpen?: boolean;
  onOpen?: (m: Machine) => void; /** A failed card's action (Try again). */ onAction?: (m: Machine) => void;
  /** Each card's ⋯ and right-click; `menuOpen` is the id whose menu is open. A machine dropped from `machines` collapses out, then the others slide over. */
  onMenu?: (m: Machine, at: { x: number; y: number; card: HTMLElement; fromButton?: boolean }) => void; menuOpen?: string | null; /** Hands back what was clicked, for ModalLayer's `from`. */ onAdd?: (from: HTMLElement) => void; onPair?: (from: HTMLElement) => void; title?: string; subtitle?: string }
/** What a window shows before it has a machine. Connects to nothing. */
export declare function MachineHome(props: MachineHomeProps): React.ReactElement;
export interface MachineLaunchProps { open: boolean; /** id of the card it grows from and lands back on */ machine?: string | null; home: React.ReactNode; children?: React.ReactNode; className?: string; style?: React.CSSProperties }
/** Home and a machine stacked; opening grows the machine out of its card like an app launch, closing runs it backwards. */
export declare function MachineLaunch(props: MachineLaunchProps): React.ReactElement;
export interface ReadyStep { label: string; detail?: string; state?: 'todo' | 'active' | 'done' | 'failed'; progress?: number; meta?: string }
export declare function GettingReady(props: { icon?: string; title: string; sub?: string; steps: ReadyStep[]; actions?: React.ReactNode; note?: string; className?: string }): React.ReactElement;
/** Turns one progress value (0 to 1) into step states, given where each step ends. */
export declare function stagedSteps(t: number, marks: number[]): Array<'todo' | 'active' | 'done'>;
export interface AddMachineProps { kind: 'ssh' | 'peer';
  /** ssh: 'host' (pick it), then 'key' (check its host key) */ step?: 'host' | 'key'; query?: string; hosts?: Array<{ name: string; detail: string }>; picked?: { name: string; user: string; port?: number; auth?: string; fromConfig?: boolean } | null; host?: string; fingerprint?: string; keyType?: string;
  /** peer */ text?: string; found?: { name: string; detail: string } | null;
  onNext?: () => void; onBack?: () => void; onCancel?: () => void }
/** A machine's menu (its card's ⋯ or right-click): Edit…, Open in a new window, Disconnect, Remove (Unpair). Remove acts at once (Undo in a Toast); with a window open it reads Remove… and asks. */
export declare function MachineMenu(props: { machine: Machine; onEdit?: () => void; onNewWindow?: () => void; onDisconnect?: () => void; onRemove?: () => void; style?: React.CSSProperties }): React.ReactElement;
/** Editing a machine (grows out of its card): name, color, and for a server host, user, port, sign-in. `step: 'remove'` asks before removing a machine with a window open. */
export declare function EditMachine(props: { machine: Machine; step?: 'edit' | 'remove'; onSave?: (patch: { name?: string; hue?: string; host?: string; user?: string; port?: number | string; key?: string }) => void; onRemove?: () => void; onCancel?: () => void }): React.ReactElement;
/** Adding a machine, in a ModalLayer over Home. It only asks; the new card then gets ready on Home. */
export declare function AddMachine(props: AddMachineProps): React.ReactElement;
export declare function HostField(props: { query?: string; hosts?: Array<{ name: string; detail: string }>; picked?: { name: string; user: string; port?: number; auth?: string; fromConfig?: boolean } | null }): React.ReactElement;
export declare function HostKeyCheck(props: { host: string; fingerprint: string; type?: string; changed?: boolean }): React.ReactElement;
export declare function PairingText(props: { text: string; copied?: boolean; onCopy?: () => void }): React.ReactElement;
export declare function PairPaste(props: { text?: string; found?: { name: string; detail: string } | null }): React.ReactElement;
export declare const MACHINE_ICON: Record<MachineKind, string>;

export interface ChatScrollProps { children?: React.ReactNode; className?: string; innerClassName?: string; style?: React.CSSProperties; /** false turns the pinned reminder off */ reminder?: boolean; /** opens scrolled to the latest message and follows new content while at the bottom (default true) */ startAtEnd?: boolean }
/** The chat's scrolling area. While you read a reply whose message has scrolled away above, that message stays pinned at the top (two lines, Back to it, Hide). Give user Messages an `id`. */
export declare function ChatScroll(props: ChatScrollProps): React.ReactElement;
export interface EaseSwapProps { /** change it to swap: the old content fades out where it was and the new one fades in over it */ k: string; className?: string; children?: React.ReactNode }
/** Swaps inline content without a jump: crossfades old and new in place while the box's width eases between them. Content with the same key updates in place. */
export declare function EaseSwap(props: EaseSwapProps): React.ReactElement;
declare global {
  interface Window {
    Elevenex: {
      Icon: typeof Icon; Button: typeof Button; IconButton: typeof IconButton; Kbd: typeof Kbd;
      StatusGlyph: typeof StatusGlyph; StatusBadge: typeof StatusBadge; StatusSummary: typeof StatusSummary;
      ProjectRail: typeof ProjectRail; ProjectMark: typeof ProjectMark; StageGlyph: typeof StageGlyph; TaskStage: typeof TaskStage;
      LinkChip: typeof LinkChip; TaskHeader: typeof TaskHeader; CloseTask: typeof CloseTask; NewTask: typeof NewTask; BranchPicker: typeof BranchPicker; BranchChip: typeof BranchChip; WorkspacePicker: typeof WorkspacePicker; TaskLine: typeof TaskLine; SessionRow: typeof SessionRow; TaskGroup: typeof TaskGroup; TaskList: typeof TaskList; FlipScope: typeof FlipScope; PanelTabs: typeof PanelTabs;
      AgentPicker: typeof AgentPicker; PresetCard: typeof PresetCard; PresetPicker: typeof PresetPicker; SessionStart: typeof SessionStart; ModeToggle: typeof ModeToggle; PermissionPicker: typeof PermissionPicker; ToolsMenu: typeof ToolsMenu;
      ComposerQueue: typeof ComposerQueue; Switch: typeof Switch; Segmented: typeof Segmented; Mention: typeof Mention; Composer: typeof Composer; Message: typeof Message;
      SideThread: typeof SideThread; GitBar: typeof GitBar; ChangeList: typeof ChangeList; DiffReview: typeof DiffReview; Markdown: typeof Markdown; BrowserView: typeof BrowserView; TerminalView: typeof TerminalView; ViewTabs: typeof ViewTabs; diffLines: typeof diffLines; usePanelTakeover: typeof usePanelTakeover;
      ApprovalCard: typeof ApprovalCard; QuestionCard: typeof QuestionCard; PlanCard: typeof PlanCard; ThinkingBlock: typeof ThinkingBlock; ToolStep: typeof ToolStep; StreamText: typeof StreamText; MentionMenu: typeof MentionMenu;
      Toast: typeof Toast; Tooltip: typeof Tooltip; SubtaskGlyph: typeof SubtaskGlyph; ModalLayer: typeof ModalLayer; Sheet: typeof Sheet; useRecede: typeof useRecede; SetGroup: typeof SetGroup; SetRow: typeof SetRow; SetField: typeof SetField; SetValue: typeof SetValue; ProjectMenu: typeof ProjectMenu; ProjectSettings: typeof ProjectSettings; DeleteProject: typeof DeleteProject; NewProject: typeof NewProject; projectFace: typeof projectFace; jumpHome: typeof jumpHome; settleMark: typeof settleMark; RepoTag: typeof RepoTag; JobBrief: typeof JobBrief; Skeleton: typeof Skeleton; ContextMeter: typeof ContextMeter; NewMessagesPill: typeof NewMessagesPill; ProgressLine: typeof ProgressLine; Ticker: typeof Ticker; Presence: typeof Presence; play: typeof play;
      Turn: typeof Turn; WorkTimeline: typeof WorkTimeline; NowLine: typeof NowLine; FileChip: typeof FileChip; OutcomeBar: typeof OutcomeBar; TurnNav: typeof TurnNav; Fold: typeof Fold;
      groupSteps: typeof groupSteps; settle: typeof settle; summarize: typeof summarize; fmtDur: typeof fmtDur;
      TurnActs: typeof TurnActs; isSay: typeof isSay; AutoHeight: typeof AutoHeight; MotionList: typeof MotionList; usePresence: typeof usePresence; useHold: typeof useHold;
      Diff: typeof Diff; WorkspaceStatus: typeof WorkspaceStatus; Waveform: typeof Waveform;
      EaseSwap: typeof EaseSwap; ChatScroll: typeof ChatScroll; TitleIsland: typeof TitleIsland; TitleBar: typeof TitleBar; IslandName: typeof IslandName; IslandEvent: typeof IslandEvent; MachinePanel: typeof MachinePanel; MachineCard: typeof MachineCard; MachineHome: typeof MachineHome; MachineLaunch: typeof MachineLaunch;
      GettingReady: typeof GettingReady; stagedSteps: typeof stagedSteps; AddMachine: typeof AddMachine; MachineAdd: typeof MachineAdd; MachineMenu: typeof MachineMenu; EditMachine: typeof EditMachine; HostField: typeof HostField; HostKeyCheck: typeof HostKeyCheck; PairingText: typeof PairingText; PairPaste: typeof PairPaste; MACHINE_ICON: typeof MACHINE_ICON;
      branchItems: typeof branchItems; branchFromTitle: typeof branchFromTitle; STATUS: typeof STATUS; STAGE: typeof STAGE; THINKING: typeof THINKING; PERMS: typeof PERMS;
    };
  }
}
