import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from "@angular/core";
import { ButtonComponent } from "../src/app/ui";
import {
  NewTaskComponent,
  TaskGroupComponent,
  TaskHeaderComponent,
  type BranchInfo,
  type CreatedTask,
  type PlannedTask,
  type SubTask,
  type TaskRepository,
} from "../src/app/tasks";

/** Isolated supplied-data fixtures; no repository scans, git or persistence. */
@Component({
  selector: "ex-task-update-demo",
  imports: [
    ButtonComponent,
    NewTaskComponent,
    TaskGroupComponent,
    TaskHeaderComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./task-update-demo.component.html",
  styleUrl: "./task-update-demo.component.css",
})
export class TaskUpdateDemoComponent {
  readonly moment = signal("deeper");
  readonly selected = signal("s22");
  readonly draftVersion = signal(0);
  readonly draftMode = signal<"multiple" | "existing" | "empty">("multiple");
  readonly intent = signal("");
  readonly project = {
    name: "Payments API",
    initials: "PA",
    hue: "ocean" as const,
  };
  readonly repos: readonly TaskRepository[] = [
    {
      id: "api",
      name: "Payments API",
      short: "api",
      path: "~/code/payments-api",
      base: "main",
    },
    {
      id: "web",
      name: "Storefront web",
      short: "web",
      path: "~/code/storefront",
      base: "develop",
    },
  ];
  readonly branches: readonly BranchInfo[] = [
    { name: "main", isDefault: true },
    { name: "fix/existing" },
    { name: "fix/held", task: "Another task" },
  ];
  readonly branchesFor = (repo: string): readonly BranchInfo[] =>
    repo === "web"
      ? [
          { name: "develop", isDefault: true },
          { name: "web/checkout" },
          { name: "web/held", task: "Storefront fixes" },
        ]
      : this.branches;
  readonly moments = [
    "work",
    "deep",
    "deeper",
    "ready",
    "merged",
    "overflow",
  ] as const;
  readonly subtasks = computed<readonly SubTask[]>(() => {
    const moment = this.moment();
    const first: SubTask = {
      id: "st1",
      title: "Null total on empty cart",
      branch: "fix/null-cart-total",
      ready: moment === "ready",
      merged: moment === "merged",
      diff: { add: 12, del: 3 },
      sessions: [
        {
          id: "s20",
          title: "Guard the empty cart",
          status: moment === "ready" ? "review" : "running",
          ...(moment === "ready"
            ? { diff: { add: 12, del: 3 } }
            : { meta: "2m" }),
        },
      ],
    };
    const second: SubTask = {
      id: "st2",
      title: "Rounding in totals",
      parent: "st1",
      branch: "fix/rounding",
      sessions: [
        {
          id: "s21",
          title: "Use integer cents",
          status: "attention",
          meta: "now",
        },
      ],
    };
    const third: SubTask = {
      id: "st3",
      title: "Currency edge cases",
      parent: "st2",
      branch: "fix/currency-cases",
      sessions: [
        {
          id: "s22",
          title: "EUR and JPY cases",
          status: "running",
          meta: "1m",
          kind: "auto",
        },
      ],
    };
    if (moment === "work" || moment === "merged") return [first];
    if (moment === "deeper") return [first, second, third];
    if (moment === "overflow")
      return [
        first,
        second,
        third,
        {
          id: "st4",
          title: "Receipt formatting",
          sessions: [{ id: "s23", title: "Receipt pass", status: "queued" }],
        },
        {
          id: "st5",
          title: "Webhook edge cases",
          sessions: [
            { id: "s24", title: "Selected beyond overflow", status: "review" },
          ],
        },
      ];
    return [first, second];
  });
  readonly task = computed(() => ({
    id: "updated-task",
    title: "Fix flaky checkout test",
    project: this.project,
    repo: this.repos[0],
    subtasks: this.subtasks(),
    sessions: [
      {
        id: "s1",
        title: "Reproduce flake locally",
        status: "running" as const,
        meta: "3m",
      },
      {
        id: "s2",
        title: "Try exponential backoff",
        status: "review" as const,
        kind: "fork" as const,
        diff: { add: 14, del: 6 },
      },
      {
        id: "s5",
        title: "Why 250ms boot?",
        status: "done" as const,
        kind: "side" as const,
      },
      { id: "s6", title: "Audit other suites", status: "done" as const },
    ],
  }));
  chooseMoment(moment: string): void {
    this.moment.set(moment);
    this.selected.set(
      moment === "deeper"
        ? "s22"
        : moment === "overflow"
          ? "s24"
          : moment === "deep"
            ? "s21"
            : "s20",
    );
  }
  chooseDraft(mode: "multiple" | "existing" | "empty"): void {
    this.draftMode.set(mode);
    this.draftVersion.update((value) => value + 1);
  }
  created(task: CreatedTask): void {
    this.intent.set(
      `Create ${task.title} in ${task.repo ?? "api"} on ${task.branch}${task.base ? ` from ${task.base}` : ""}`,
    );
  }
  planned(task: PlannedTask): void {
    this.intent.set(`Save planned: ${task.title}`);
  }
}
