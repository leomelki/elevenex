import { A11yModule } from "@angular/cdk/a11y";
import { OverlayModule } from "@angular/cdk/overlay";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from "@angular/core";
import { AppShellComponent } from "../src/app/shell/app-shell.component";
import { ProjectRailComponent } from "../src/app/tasks/projects/project-rail.component";
import { TaskListComponent } from "../src/app/tasks/outline/task-list.component";
import { TaskHeaderComponent } from "../src/app/tasks/lifecycle/task-header.component";
import { NewTaskComponent } from "../src/app/tasks/branches/new-task.component";
import { PanelTabsComponent } from "../src/app/tasks/navigation/panel-tabs.component";
import { TitleIslandComponent } from "../src/app/machines/title-island.component";
import { IslandNameComponent } from "../src/app/machines/island-name.component";
import { MachinePanelComponent } from "../src/app/machines/machine-panel.component";
import { DiffReviewComponent } from "../src/app/views/diff-review.component";
import { TerminalViewComponent } from "../src/app/views/terminal-view.component";
import { BrowserViewComponent } from "../src/app/views/browser-view.component";
import { ComposerComponent } from "../src/app/conversation/composer/composer.component";
import { MessageComponent } from "../src/app/conversation/chat/message.component";
import { TurnComponent } from "../src/app/conversation/turns/turn.component";
import { MarkdownComponent } from "../src/app/conversation/markdown/markdown.component";
import {
  ButtonComponent,
  IconButtonComponent,
  IconComponent,
  KbdComponent,
} from "../src/app/ui";
import type {
  CreatedTask,
  PanelTab,
  Project,
  TaskOutline,
} from "../src/app/tasks/task.models";
import type {
  AgentConfig,
  ComposerSubmission,
  ConversationMode,
  PermissionLevel,
  WorkStep,
} from "../src/app/conversation/conversation.models";
import type { Machine } from "../src/app/machines/machine.models";
import type {
  ChangeFile,
  DiffFileContent,
  ReviewMode,
} from "../src/app/views/view.models";

@Component({
  selector: "ex-workspace-demo",
  imports: [
    A11yModule,
    OverlayModule,
    AppShellComponent,
    ProjectRailComponent,
    TaskListComponent,
    TaskHeaderComponent,
    NewTaskComponent,
    PanelTabsComponent,
    TitleIslandComponent,
    IslandNameComponent,
    MachinePanelComponent,
    DiffReviewComponent,
    TerminalViewComponent,
    BrowserViewComponent,
    ComposerComponent,
    MessageComponent,
    TurnComponent,
    MarkdownComponent,
    ButtonComponent,
    IconButtonComponent,
    IconComponent,
    KbdComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./workspace-demo.component.html",
  styleUrl: "./workspace-demo.component.css",
})
export class WorkspaceDemoComponent {
  readonly machine: Machine = {
    id: "local",
    name: "This Mac",
    kind: "local",
    conn: "live",
    color: "pine",
  };
  readonly projects: readonly Project[] = [
    {
      id: "web",
      name: "Storefront web",
      initials: "SW",
      hue: "rust",
      running: 1,
    },
    {
      id: "api",
      name: "Payments API",
      initials: "PA",
      hue: "ocean",
      attention: 1,
      running: 1,
    },
    { id: "ios", name: "iOS app", initials: "iO", hue: "plum" },
    { id: "infra", name: "Infra", initials: "IN", hue: "pine", attention: 1 },
    { id: "docs", name: "Docs site", initials: "DS", hue: "steel" },
  ];
  readonly tasks = signal<readonly TaskOutline[]>([
    {
      id: "checkout",
      title: "Fix flaky checkout test",
      project: this.projects[1]!,
      stage: "active",
      sessions: [
        {
          id: "reproduce",
          title: "Reproduce flake locally",
          status: "running",
          diff: { add: 92, del: 35 },
        },
        {
          id: "backoff",
          title: "Try exponential backoff",
          status: "review",
          kind: "fork",
          diff: { add: 14, del: 6 },
        },
        {
          id: "load-test",
          title: "Load-test the backoff",
          status: "running",
          meta: "1m",
        },
        { id: "boot", title: "Why 250ms boot?", status: "done", kind: "side" },
      ],
    },
    {
      id: "ledger",
      title: "Migrate ledger to v2",
      project: this.projects[1]!,
      stage: "active",
      sessions: [
        {
          id: "approve",
          title: "Approve migration run",
          status: "attention",
          meta: "waiting",
        },
      ],
    },
    {
      id: "receipts",
      title: "Dark mode for receipts",
      project: this.projects[0]!,
      stage: "active",
      sessions: [
        {
          id: "theme",
          title: "Theme tokens pass",
          status: "running",
          meta: "1m",
        },
      ],
    },
    {
      id: "certs",
      title: "Rotate staging certs",
      project: this.projects[3]!,
      stage: "active",
      sessions: [
        {
          id: "dns",
          title: "Confirm DNS change",
          status: "attention",
          meta: "4m",
        },
      ],
    },
    {
      id: "refund",
      title: "Refund webhooks",
      project: this.projects[1]!,
      stage: "waiting",
      sessions: [{ id: "retry", title: "Retry policy", status: "done" }],
    },
    {
      id: "cart",
      title: "Offline cart",
      project: this.projects[2]!,
      stage: "waiting",
      sessions: [{ id: "sync", title: "Sync on reconnect", status: "done" }],
    },
    {
      id: "limits",
      title: "Rate-limit refunds",
      project: this.projects[1]!,
      stage: "planned",
      sessions: [],
    },
  ]);
  readonly activeProject = signal("all");
  readonly selected = signal("reproduce");
  readonly panelOpen = signal(true);
  readonly panel = signal("changes");
  readonly wide = signal(false);
  readonly wizard = signal(false);
  readonly machineOpen = signal(false);
  readonly mode = signal<ConversationMode>("code");
  readonly permission = signal<PermissionLevel>("edits");
  readonly running = signal(true);
  readonly messages = signal<readonly string[]>([]);
  readonly agent = signal<AgentConfig>({
    mark: "CX",
    harness: "Codex",
    model: "Deep work",
    thinking: "High",
    context: 0.62,
  });
  readonly tabs: readonly PanelTab[] = [
    { id: "terminal", label: "Terminal", icon: "terminal" },
    { id: "changes", label: "Changes", icon: "changes" },
    { id: "browser", label: "Browser", icon: "globe" },
  ];
  readonly visibleTasks = computed(() =>
    this.activeProject() === "all"
      ? this.tasks()
      : this.tasks().filter(
          (task) =>
            task.project?.name ===
            this.projects.find((project) => project.id === this.activeProject())
              ?.name,
        ),
  );
  readonly selectedTask = computed(
    () =>
      this.tasks().find((task) =>
        task.sessions.some((session) => session.id === this.selected()),
      ) ?? this.tasks()[0]!,
  );
  readonly branch = signal("leo/flaky-checkout");
  readonly files = signal<readonly ChangeFile[]>([
    {
      id: "retry",
      path: "payments/retry.ts",
      status: "A",
      add: 49,
      del: 0,
      rev: 1,
    },
    {
      id: "client",
      path: "payments/client.ts",
      status: "M",
      add: 34,
      del: 12,
      rev: 1,
    },
    {
      id: "setup",
      path: "test/globalSetup.ts",
      status: "M",
      add: 9,
      del: 0,
      rev: 1,
    },
  ]);
  readonly reviewMode = signal<ReviewMode>("changes");
  readonly wrap = signal(true);
  readonly contents: readonly DiffFileContent[] = ["changes", "full"].flatMap(
    (mode) => [
      {
        fileId: "retry",
        rev: 1,
        mode: mode as ReviewMode,
        state: "ready" as const,
        hunks: [
          {
            id: "retry-main",
            heading: "@@ -0,0 +1,8 @@",
            lines: [
              {
                id: "1",
                kind: "add" as const,
                newNumber: 1,
                text: "/** Capped exponential backoff. */",
              },
              {
                id: "2",
                kind: "add" as const,
                newNumber: 2,
                text: "export function expo(attempt: number) {",
              },
              {
                id: "3",
                kind: "add" as const,
                newNumber: 3,
                text: "  const delay = Math.min(2000, 100 * 2 ** attempt);",
              },
              {
                id: "4",
                kind: "add" as const,
                newNumber: 4,
                text: "  return delay / 2 + Math.random() * (delay / 2);",
              },
              { id: "5", kind: "add" as const, newNumber: 5, text: "}" },
            ],
          },
        ],
      },
      {
        fileId: "client",
        rev: 1,
        mode: mode as ReviewMode,
        state: "ready" as const,
        hunks: [
          {
            id: "client-key",
            heading: "@@ -52,3 +52,4 @@",
            lines: [
              {
                id: "1",
                kind: "context" as const,
                oldNumber: 52,
                newNumber: 52,
                text: "const body = toBody(req);",
              },
              {
                id: "2",
                kind: "del" as const,
                oldNumber: 53,
                text: "const res = await withRetry(() => post(body));",
              },
              {
                id: "3",
                kind: "add" as const,
                newNumber: 53,
                text: "const key = req.idempotencyKey ?? crypto.randomUUID();",
              },
              {
                id: "4",
                kind: "add" as const,
                newNumber: 54,
                text: "const res = await withRetry(() => post(body, key));",
              },
            ],
          },
        ],
      },
      {
        fileId: "setup",
        rev: 1,
        mode: mode as ReviewMode,
        state: "ready" as const,
        hunks: [
          {
            id: "setup-main",
            heading: "@@ -1,2 +1,3 @@",
            lines: [
              {
                id: "1",
                kind: "context" as const,
                oldNumber: 1,
                newNumber: 1,
                text: "import { server } from './mocks';",
              },
              {
                id: "2",
                kind: "add" as const,
                newNumber: 2,
                text: "await prepareSchemas();",
              },
              {
                id: "3",
                kind: "context" as const,
                oldNumber: 2,
                newNumber: 3,
                text: "server.listen();",
              },
            ],
          },
        ],
      },
    ],
  );
  readonly doneSteps: readonly WorkStep[] = [
    { id: "read", kind: "read", detail: "payments/client.ts", status: "done" },
    {
      id: "edit",
      kind: "edit",
      detail: "payments/retry.ts",
      status: "done",
      diff: { add: 49, del: 0 },
    },
    {
      id: "tests",
      kind: "test",
      detail: "pnpm test --filter checkout",
      status: "done",
      result: "64/64 passed",
    },
  ];
  readonly liveSteps: readonly WorkStep[] = [
    {
      id: "say",
      kind: "say",
      text: "The fix holds locally. Running it 200 times before pushing.",
    },
    {
      id: "test",
      kind: "test",
      detail: "pnpm test --filter checkout --repeat 200",
      status: "running",
      verb: "Testing",
      meta: "143 / 200",
      progress: 0.715,
      elapsed: 104,
    },
  ];
  readonly answer =
    "The timeout comes from the retry wrapper in `payments/client.ts`: it retries on a fixed 200ms delay while the mock server needs up to 250ms to boot.\n\nI moved schema compilation into `globalSetup` and switched the wrapper to capped exponential backoff. One idempotency key is shared across attempts, so a retry never bills twice.";

  createTask(task: CreatedTask): void {
    const id = `preview-task-${this.tasks().length}`;
    this.tasks.update((tasks) => [
      ...tasks,
      {
        id,
        title: task.title,
        stage: "active",
        project: this.projects[1]!,
        sessions: [
          {
            id: `${id}-session`,
            title: "Start a conversation",
            status: "queued",
          },
        ],
      },
    ]);
    this.selected.set(`${id}-session`);
    this.wizard.set(false);
  }
  submit(message: ComposerSubmission): void {
    this.messages.update((messages) => [...messages, message.text]);
  }
  markViewed(event: { fileId: string; viewed: boolean }): void {
    this.files.update((files) =>
      files.map((file) =>
        file.id === event.fileId ? { ...file, viewed: event.viewed } : file,
      ),
    );
  }
}
