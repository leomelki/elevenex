import { CdkMenuTrigger } from '@angular/cdk/menu';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnInit,
  TemplateRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import {
  AutoHeightDirective,
  ButtonComponent,
  EaseSwapComponent,
  FoldComponent,
  IconComponent,
  KbdComponent,
} from "../../ui";
import type {
  BranchInfo,
  BranchRow,
  CreatedTask,
  PlannedTask,
  ProjectMark,
  TaskLink,
  TaskRepository,
  Workspace,
} from "../task.models";
import { ProjectMarkComponent } from "../projects/project-mark.component";
import { LinkChipComponent } from "../lifecycle/link-chip.component";
import { RepoTagComponent } from "../lifecycle/repo-tag.component";
import { BranchPickerComponent } from "./branch-picker.component";
import { WorkspacePickerComponent } from "./workspace-picker.component";
import {
  branchFromTitle,
  branchItems,
  selectableBranch,
  validBranchName,
} from "./branch-options";

export type NewTaskStep = "name" | "repo" | "branch" | "base";

@Component({
  selector: "ex-new-task",
  imports: [
    CdkMenuTrigger,
    AutoHeightDirective,
    ButtonComponent,
    EaseSwapComponent,
    FoldComponent,
    IconComponent,
    KbdComponent,
    ProjectMarkComponent,
    LinkChipComponent,
    RepoTagComponent,
    BranchPickerComponent,
    WorkspacePickerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./new-task.component.html",
  styleUrl: "./new-task.component.css",
})
export class NewTaskComponent implements OnInit {
  readonly project = input.required<ProjectMark>();
  /** Owner-supplied choices anchored to the existing project button. */
  readonly projectMenu = input<TemplateRef<unknown> | null>(null);
  readonly active = input(true);
  readonly repos = input<readonly TaskRepository[]>([]);
  /** Initial repository, usually the current task's or the last used one. */
  readonly repo = input<string>();
  readonly branches = input<readonly BranchInfo[]>([]);
  /** Pure supplied data lookup. Platform access belongs to the owning feature. */
  readonly branchesFor = input<(repoId: string) => readonly BranchInfo[]>();
  readonly basesFor = input<(repoId: string) => readonly BranchInfo[]>();
  readonly branchesLoading = input(false);
  readonly canLink = input(true);
  readonly canManageWorkspaces = input(true);
  readonly bases = input<readonly BranchInfo[]>();
  readonly base = input("main");
  readonly branchPrefix = input("");
  /** Initial form values are read once. Recreate the form for a different draft. */
  readonly title = input("");
  readonly step = input<NewTaskStep>("name");
  readonly branchQuery = input<string>();
  readonly baseQuery = input("");
  readonly hi = input(0);
  readonly workspace = input("auto");
  readonly workspaces = input<readonly Workspace[]>([]);
  readonly links = input<readonly TaskLink[]>([]);
  readonly autoFocus = input(true);
  readonly create = output<CreatedTask>();
  readonly plan = output<PlannedTask>();
  readonly cancelled = output<void>();
  readonly linkRequested = output<void>();
  readonly projectRequested = output<void>();
  readonly addRepository = output<void>();
  readonly workspaceRequested = output<"new" | "manage">();
  readonly branchQueryRequested = output<{ readonly repoId: string; readonly query: string; readonly kind: 'branch' | 'base' }>();
  protected readonly titleValue = signal("");
  protected readonly currentStep = signal<NewTaskStep>("name");
  protected readonly branchQueryValue = signal<string | null>(null);
  protected readonly baseQueryValue = signal("");
  protected readonly highlighted = signal(0);
  protected readonly pickedBranch = signal<BranchRow | null>(null);
  protected readonly pickedBase = signal<string | null>(null);
  protected readonly pickedWorkspace = signal<string | null>(null);
  private readonly pickedRepo = signal<string | null>(null);
  protected readonly multipleRepos = computed(() => this.repos().length > 1);
  protected readonly currentRepo = computed(
    () =>
      this.repos().find(
        (repo) => repo.id === (this.pickedRepo() ?? this.repo()),
      ) ?? this.repos()[0],
  );
  protected readonly defaultBase = computed(
    () => this.currentRepo()?.base || this.base(),
  );
  private readonly currentBranches = computed(() => {
    const repo = this.currentRepo();
    const lookup = this.branchesFor();
    return repo && lookup ? lookup(repo.id) : this.branches();
  });
  protected readonly branchValue = computed(
    () =>
      this.branchQueryValue() ??
      branchFromTitle(this.titleValue(), this.branchPrefix()),
  );
  protected readonly branchRows = computed(() =>
    branchItems(this.branchValue(), this.currentBranches(), true),
  );
  protected readonly baseBranches = computed(() =>
    (this.basesFor() && this.currentRepo()
      ? this.basesFor()?.(this.currentRepo()?.id ?? '') ?? []
      : this.branchesFor() ? this.currentBranches()
      : (this.bases() ?? this.currentBranches())
    )
      .filter((branch) => !branch.task)
      .map((branch) => ({
        ...branch,
        isDefault: branch.name === this.defaultBase(),
      })),
  );
  protected readonly baseRows = computed(() =>
    branchItems(this.baseQueryValue(), this.baseBranches()),
  );
  protected readonly branch = computed(() => {
    const picked = this.pickedBranch();
    if (picked) return picked;
    const row =
      this.currentStep() === "branch"
        ? this.branchRows()[this.highlighted()]
        : this.branchRows().find(selectableBranch);
    return this.branchValue().trim() && row && selectableBranch(row)
      ? row
      : null;
  });
  protected readonly baseValue = computed(
    () => this.pickedBase() ?? this.defaultBase(),
  );
  protected readonly workspaceValue = computed(
    () => this.pickedWorkspace() ?? this.workspace(),
  );
  protected readonly existing = computed(
    () => this.branch()?.kind === "branch",
  );
  protected readonly canCreate = computed(
    () =>
      !this.branchesLoading() &&
      !!this.titleValue().trim() &&
      !!this.branch() &&
      this.branchAvailable() &&
      (this.existing() ||
        this.baseBranches().some((branch) => branch.name === this.baseValue())),
  );
  protected readonly canNext = computed(() => {
    if (this.branchesLoading() && (this.currentStep() === 'branch' || this.currentStep() === 'base')) return false;
    switch (this.currentStep()) {
      case "name":
        return !!this.titleValue().trim();
      case "repo":
        return !!this.repos()[this.highlighted()];
      case "branch": {
        const row = this.branchRows()[this.highlighted()];
        return !!row && selectableBranch(row);
      }
      case "base": {
        const row = this.baseRows()[this.highlighted()];
        return (
          this.branchAvailable() &&
          !!this.titleValue().trim() &&
          (this.existing() ? this.canCreate() : !!row && selectableBranch(row))
        );
      }
    }
  });
  private readonly branchAvailable = computed(() => {
    const chosen = this.branch();
    if (!chosen) return false;
    const current = this.currentBranches().find(
      (branch) => branch.name === chosen.name,
    );
    return chosen.kind === "branch"
      ? !!current && !current.task
      : !current && validBranchName(chosen.name);
  });
  protected readonly nameField =
    viewChild<ElementRef<HTMLInputElement>>("nameField");
  protected readonly repoList = viewChild<ElementRef<HTMLElement>>("repoList");
  protected readonly branchField =
    viewChild<ElementRef<HTMLInputElement>>("branchField");
  protected readonly baseField =
    viewChild<ElementRef<HTMLInputElement>>("baseField");
  protected readonly mainButton = viewChild<
    ButtonComponent,
    ElementRef<HTMLButtonElement>
  >("mainButton", { read: ElementRef });
  protected readonly branchListId = `new-task-branches-${crypto.randomUUID()}`;
  protected readonly baseListId = `new-task-bases-${crypto.randomUUID()}`;
  protected readonly repoListId = `new-task-repos-${crypto.randomUUID()}`;
  private readonly injector = inject(Injector);
  private readonly projectTrigger = viewChild(CdkMenuTrigger);
  private readonly branchRequest = computed(() => {
    const repo = this.currentRepo(), step = this.currentStep();
    // Existing branches keep their history; loading unused bases would disable
    // Create just as the From step hands keyboard focus to that button.
    if (!repo || (step !== 'branch' && step !== 'base') || (step === 'base' && this.existing())) return null;
    return { repoId: repo.id, query: step === 'base' ? this.baseQueryValue() : this.branchValue(), kind: step === 'base' ? 'base' as const : 'branch' as const };
  }, { equal: (previous, next) => previous?.repoId === next?.repoId && previous?.query === next?.query && previous?.kind === next?.kind });
  constructor() {
    afterRenderEffect(() => {
      if (!this.active() || !this.projectMenu()) this.projectTrigger()?.close();
    });
    effect(() => {
      const request = this.branchRequest();
      if (request) untracked(() => this.branchQueryRequested.emit(request));
    });
    afterNextRender(() => {
      if (this.autoFocus()) this.focusCurrent();
    });
  }
  ngOnInit(): void {
    this.titleValue.set(this.title());
    this.currentStep.set(
      this.step() === "repo" && !this.multipleRepos() ? "branch" : this.step(),
    );
    this.branchQueryValue.set(this.branchQuery() ?? null);
    this.baseQueryValue.set(this.baseQuery());
    this.highlighted.set(
      this.step() === "repo"
        ? Math.max(
            0,
            this.repos().findIndex(
              (repo) => repo.id === this.currentRepo()?.id,
            ),
          )
        : this.hi(),
    );
  }
  protected nameChanged(value: string): void {
    this.titleValue.set(value);
    this.pickedBranch.set(null);
  }
  protected branchChanged(value: string | null): void {
    this.branchQueryValue.set(value);
    this.pickedBranch.set(null);
    this.highlighted.set(0);
  }
  protected baseChanged(value: string): void {
    this.baseQueryValue.set(value);
    this.highlighted.set(0);
  }
  protected go(step: NewTaskStep): void {
    this.currentStep.set(step);
    this.highlighted.set(
      step === "repo"
        ? Math.max(
            0,
            this.repos().findIndex(
              (repo) => repo.id === this.currentRepo()?.id,
            ),
          )
        : 0,
    );
    afterNextRender(() => this.focusCurrent(), { injector: this.injector });
  }
  protected state(step: NewTaskStep): "active" | "done" | "todo" | "skip" {
    if (this.currentStep() === step) return "active";
    if (step === "base" && this.existing()) return "skip";
    const order: readonly NewTaskStep[] = ["name", "repo", "branch", "base"];
    return order.indexOf(this.currentStep()) > order.indexOf(step)
      ? "done"
      : "todo";
  }
  protected pickRepo(id: string): void {
    if (!this.repos().some((repo) => repo.id === id)) return;
    this.pickedRepo.set(id);
    this.pickedBranch.set(null);
    this.pickedBase.set(null);
    this.baseQueryValue.set("");
    this.go("branch");
  }
  protected pickBranch(row: BranchRow): void {
    if (this.branchesLoading() || !selectableBranch(row)) return;
    this.pickedBranch.set(row);
    this.go("base");
  }
  protected pickBase(row: BranchRow): void {
    if (this.branchesLoading() || !selectableBranch(row) || row.kind !== "branch") return;
    this.pickedBase.set(row.name);
    this.submit();
  }
  protected next(): void {
    if (!this.canNext()) return;
    switch (this.currentStep()) {
      case "name":
        this.go(this.multipleRepos() ? "repo" : "branch");
        break;
      case "repo": {
        const repo = this.repos()[this.highlighted()];
        if (repo) this.pickRepo(repo.id);
        break;
      }
      case "branch": {
        const row = this.branchRows()[this.highlighted()];
        if (row) this.pickBranch(row);
        break;
      }
      case "base": {
        if (this.existing()) this.submit();
        else {
          const row = this.baseRows()[this.highlighted()];
          if (row) this.pickBase(row);
        }
        break;
      }
    }
  }
  protected submit(): void {
    const branch = this.branch();
    if (!this.canCreate() || !branch) return;
    this.create.emit({
      ...(this.multipleRepos() ? { repo: this.currentRepo()?.id } : {}),
      title: this.titleValue().trim(),
      branch: branch.name,
      existing: branch.kind === "branch",
      base: branch.kind === "branch" ? null : this.baseValue(),
      workspace: this.workspaceValue(),
    });
  }
  protected savePlanned(): void {
    if (this.branchesLoading() || !this.titleValue().trim()) return;
    this.plan.emit({
      ...(this.multipleRepos() ? { repo: this.currentRepo()?.id } : {}),
      title: this.titleValue().trim(),
      branch: this.branch()?.name,
      base: this.existing() ? undefined : this.baseValue(),
      workspace: this.workspaceValue(),
    });
  }
  protected onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.cancelled.emit();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.submit();
      return;
    }
    if (event.key === "Enter" && event.altKey) {
      event.preventDefault();
      this.savePlanned();
      return;
    }
    if (
      event.key === "Tab" &&
      event.shiftKey &&
      this.currentStep() !== "name"
    ) {
      event.preventDefault();
      this.go(
        this.currentStep() === "base"
          ? "branch"
          : this.currentStep() === "branch" && this.multipleRepos()
            ? "repo"
            : "name",
      );
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest("footer")) return;
    // Native buttons retain their own activation (including Add repository).
    if (target instanceof HTMLButtonElement) return;
    const rows =
      this.currentStep() === "repo"
        ? this.repos()
        : this.currentStep() === "branch"
          ? this.branchRows()
          : this.currentStep() === "base"
            ? this.baseRows()
            : null;
    if (rows && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      let next = this.highlighted() + direction;
      while (next >= 0 && next < rows.length) {
        const row = rows[next];
        if (row && (!("kind" in row) || selectableBranch(row))) {
          this.highlighted.set(next);
          break;
        }
        next += direction;
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.next();
    }
  }
  private focusCurrent(): void {
    if (this.currentStep() === "repo") {
      this.repoList()?.nativeElement.focus();
      return;
    }
    if (this.currentStep() === "base" && this.existing()) {
      this.mainButton()?.nativeElement.focus();
      return;
    }
    const field =
      this.currentStep() === "name"
        ? this.nameField()
        : this.currentStep() === "branch"
          ? this.branchField()
          : this.baseField();
    field?.nativeElement.focus();
    if (this.currentStep() !== "name") field?.nativeElement.select();
  }
}
