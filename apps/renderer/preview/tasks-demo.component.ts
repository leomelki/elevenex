import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from '@angular/core';
import { ButtonComponent, IconComponent } from '../src/app/ui';
import {
  BranchChipComponent,
  BranchPickerComponent,
  CloseTaskComponent,
  GitBarComponent,
  LinkChipComponent,
  NewTaskComponent,
  PanelTabsComponent,
  ProjectMarkComponent,
  ProjectRailComponent,
  SessionRowComponent,
  StageGlyphComponent,
  StatusSummaryComponent,
  TaskHeaderComponent,
  TaskGroupComponent,
  TaskLineComponent,
  TaskListComponent,
  TaskStageComponent,
  WorkspacePickerComponent,
  type BranchInfo,
  type CloseTaskIntent,
  type CreatedTask,
  type GitAction,
  type GitState,
  type PanelTab,
  type PlannedTask,
  type Project,
  type ProjectHue,
  type SessionStatus,
  type SummaryStatus,
  type TaskOutline,
  type TaskSession,
  type TaskStage,
  type Workspace,
} from '../src/app/tasks';

@Component({
  selector: 'ex-tasks-demo',
  host: { 'data-modal-window': '' },
  imports: [
    ButtonComponent,
    IconComponent,
    BranchChipComponent,
    BranchPickerComponent,
    CloseTaskComponent,
    GitBarComponent,
    LinkChipComponent,
    NewTaskComponent,
    PanelTabsComponent,
    ProjectMarkComponent,
    ProjectRailComponent,
    SessionRowComponent,
    StageGlyphComponent,
    StatusSummaryComponent,
    TaskHeaderComponent,
    TaskGroupComponent,
    TaskLineComponent,
    TaskListComponent,
    TaskStageComponent,
    WorkspacePickerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tasks-demo.component.html',
  styleUrl: './tasks-demo.component.css',
})
export class TasksDemoComponent {
  protected readonly busySelected = signal<string | null>(null);
  protected readonly busyTask = signal<TaskOutline>({ id: 'busy', title: 'A busy task', sessions: Array.from({length:19},(_,index)=>({ id:`busy-${index}`,title:`Investigate retry behavior ${index + 1}`,status:index === 0 ? 'attention' : index === 3 ? 'failed' : index === 18 ? 'review' : 'running' })) });
  protected archiveBusy(session: TaskSession): void {
    this.busyTask.update(task=>({...task,sessions:task.sessions.filter(row=>row.id!==session.id)}));
    if (this.busySelected() === session.id) this.busySelected.set(this.busyTask().sessions.find(row=>row.status!=='done')?.id ?? null);
    this.note.set(`Archived “${session.title}”. The connected workspace preview also exercises Undo.`);
  }
  protected readonly projects: readonly Project[] = [
    {
      id: 'elevenex',
      name: 'Elevenex',
      initials: 'EX',
      hue: 'ocean',
      attention: 2,
      running: 3,
    },
    {
      id: 'payments',
      name: 'Payments',
      initials: 'PA',
      hue: 'pine',
      running: 1,
    },
    { id: 'studio', name: 'Studio', initials: 'ST', hue: 'plum', muted: true },
  ];
  protected readonly project = this.projects[0]!;
  protected readonly scope = signal('all');
  protected readonly filter = signal<SummaryStatus | null>(null);
  protected readonly selected = signal('rate-code');
  protected readonly stage = signal<TaskStage>('active');
  protected readonly panel = signal('changes');
  protected readonly panelOpen = signal(true);
  protected readonly closeOpen = signal(false);
  protected readonly workspace = signal('auto');
  protected readonly copied = signal(false);
  protected readonly branchName = signal('leo/rate-limit-refunds');
  protected readonly note = signal(
    'Select a session, try the branch field, or create a task.',
  );
  protected readonly git = signal<GitState>({
    files: 7,
    add: 214,
    del: 38,
    ahead: 2,
  });
  protected readonly branches: readonly BranchInfo[] = [
    { name: 'main', isDefault: true, when: 'just now' },
    { name: 'leo/refund-retries', when: '8m ago' },
    { name: 'feature/refund-history', remote: true, when: '1h ago' },
    { name: 'feature/refund-rate', task: 'Refund rate controls' },
    { name: 'release/october', remote: true, when: 'yesterday' },
  ];
  protected readonly workspaces: readonly Workspace[] = [
    { name: 'workspace-02', state: 'free', note: 'dependencies ready' },
    { name: 'workspace-03', state: 'free', note: 'clean checkout' },
    { name: 'workspace-01', state: 'used', task: 'Refund rate controls' },
  ];
  protected readonly tasks = signal<readonly TaskOutline[]>([
    {
      id: 'rate',
      title: 'Rate-limit refunds',
      stage: 'active',
      project: this.project,
      sessions: [
        {
          id: 'rate-code',
          title: 'Add exponential backoff',
          status: 'running',
          diff: { add: 214, del: 38 },
        },
        {
          id: 'rate-check',
          title: 'Choose the retry window',
          status: 'attention',
          kind: 'side',
          meta: 'waiting',
        },
        {
          id: 'rate-review',
          title: 'Review edge cases',
          status: 'review',
          kind: 'fork',
          diff: { add: 42, del: 8 },
        },
        {
          id: 'rate-done',
          title: 'Reproduce the timeout',
          status: 'done',
          meta: '4m ago',
        },
      ],
    },
    {
      id: 'pool',
      title: 'Keep workspaces warm',
      stage: 'active',
      project: this.projects[1],
      sessions: [
        {
          id: 'pool-code',
          title: 'Prepare the checkout pool',
          status: 'running',
          meta: '2m',
        },
        {
          id: 'pool-failed',
          title: 'Check cleanup behavior',
          status: 'failed',
          meta: 'exit 1',
        },
      ],
    },
    {
      id: 'settings',
      title: 'Project settings',
      stage: 'waiting',
      project: this.projects[2],
      sessions: [
        {
          id: 'settings-review',
          title: 'Review settings layout',
          status: 'review',
        },
      ],
    },
    {
      id: 'shortcuts',
      title: 'Keyboard shortcuts',
      stage: 'planned',
      project: this.project,
      sessions: [
        {
          id: 'shortcut-plan',
          title: 'Map navigation commands',
          status: 'queued',
        },
      ],
    },
    {
      id: 'closed',
      title: 'Ship the shell',
      stage: 'closed',
      sessions: [
        {
          id: 'closed-done',
          title: 'Polish the glass regions',
          status: 'done',
        },
      ],
    },
  ]);
  protected readonly scopedTasks = computed(() =>
    this.scope() === 'all'
      ? this.tasks()
      : this.tasks().filter(
          (task) =>
            task.project?.name ===
            this.projects.find((project) => project.id === this.scope())?.name,
        ),
  );
  protected readonly tabs: readonly PanelTab[] = [
    { id: 'terminal', label: 'Terminal', icon: 'terminal' },
    { id: 'actions', label: 'Actions', icon: 'actions' },
    { id: 'changes', label: 'Changes', icon: 'changes', badge: true },
    { id: 'code', label: 'Code', icon: 'code' },
    { id: 'browser', label: 'Browser', icon: 'globe' },
  ];
  protected readonly hues: readonly ProjectHue[] = [
    'ocean',
    'pine',
    'plum',
    'rust',
    'steel',
    'rose',
  ];
  protected togglePanel(): void {
    this.panelOpen.update((value) => !value);
  }
  protected readonly stages: readonly TaskStage[] = [
    'planned',
    'active',
    'waiting',
    'closed',
  ];
  protected readonly statuses: readonly SessionStatus[] = [
    'running',
    'attention',
    'review',
    'done',
    'failed',
    'queued',
  ];

  protected createTask(task: CreatedTask): void {
    const id = `created-${this.tasks().length}`;
    this.tasks.update((tasks) => [
      ...tasks,
      {
        id,
        title: task.title,
        project: this.project,
        stage: 'active',
        fresh: true,
        sessions: [
          {
            id: `${id}-session`,
            title: 'Start the work',
            status: 'queued',
            fresh: true,
          },
        ],
      },
    ]);
    this.note.set(
      `Created ${task.title} on ${task.branch}${task.base ? ` from ${task.base}` : ''}.`,
    );
  }
  protected planTask(task: PlannedTask): void {
    this.tasks.update((tasks) => [
      ...tasks,
      {
        id: `planned-${tasks.length}`,
        title: task.title,
        project: this.project,
        stage: 'planned',
        sessions: [],
        fresh: true,
      },
    ]);
    this.note.set(`Saved ${task.title} as planned.`);
  }
  protected changeStage(stage: TaskStage): void {
    this.stage.set(stage);
    this.tasks.update((tasks) =>
      tasks.map((task) => (task.id === 'rate' ? { ...task, stage } : task)),
    );
  }
  protected selectSession(value: {
    readonly taskId: string;
    readonly sessionId: string;
  }): void {
    this.selected.set(value.sessionId);
    this.note.set(`Opened ${value.sessionId}.`);
  }
  protected addSession(taskId: string): void {
    const id = `${taskId}-${Date.now()}`;
    this.tasks.update((tasks) =>
      tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              sessions: [
                ...task.sessions,
                {
                  id,
                  title: 'Explore another approach',
                  status: 'queued',
                  kind: 'fork',
                  fresh: true,
                },
              ],
            }
          : task,
      ),
    );
    this.selected.set(id);
  }
  protected gitAction(action: GitAction): void {
    if (action === 'commit')
      this.git.update((state) => ({
        ...state,
        files: 0,
        add: 0,
        del: 0,
        ahead: (state.ahead ?? 0) + 1,
      }));
    else if (action === 'push')
      this.git.update((state) => ({ ...state, ahead: 0 }));
    this.note.set(`Requested ${action}.`);
  }
  protected closed(intent: CloseTaskIntent): void {
    this.closeOpen.set(false);
    this.changeStage('closed');
    this.note.set(
      `Task closed${intent.push ? ' after pushing' : ''}${intent.moveTicket ? '; PAY-212 moved to Done' : ''}.`,
    );
  }
  protected copyBranch(name: string): void {
    this.copied.set(true);
    this.note.set(`Copy requested: ${name}`);
  }
}
