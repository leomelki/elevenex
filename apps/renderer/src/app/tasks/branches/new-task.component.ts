import { CdkMenuTrigger } from '@angular/cdk/menu';
import { WORKSPACE_BRANCH_REF_LIMIT } from '@elevenex/shared';
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
  branchRef,
  selectableBranch,
  shortBranchName,
  validBranchName,
} from "./branch-options";

export type NewTaskStep = "name" | "repo" | "branch" | "base";
export interface TaskBranchSearch {
  readonly repoId: string;
  readonly query: string;
  readonly kind: "branch" | "base";
}

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
  readonly waitingFor = input<string>();
  readonly repos = input<readonly TaskRepository[]>([]);
  /** Initial repository, usually the current task's or the last used one. */
  readonly repo = input<string>();
  readonly branches = input<readonly BranchInfo[]>([]);
  /** Pure supplied data lookup. Platform access belongs to the owning feature. */
  readonly branchesFor = input<(repoId: string) => readonly BranchInfo[]>();
  readonly basesFor = input<(repoId: string) => readonly BranchInfo[]>();
  readonly branchesLoading = input(false);
  readonly branchSearchFailed = input(false);
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
  readonly branchQueryRequested = output<TaskBranchSearch | null>();
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
  private readonly baseBranches = computed(() => {
    const repo = this.currentRepo();
    const lookup = this.basesFor();
    const choices = repo && lookup ? lookup(repo.id) : this.bases() ?? this.currentBranches();
    const preferred = this.defaultBase();
    return choices.map(branch => ({
      ...branch,
      isDefault: branchRef(branch) === preferred || (!branch.ref && branch.name === shortBranchName(preferred)),
    }));
  });
  protected readonly baseRows = computed(() =>
    branchItems(this.baseQueryValue(), this.baseBranches()),
  );
  protected readonly branch = computed(() => {
    if (this.currentStep() === "branch") {
      const row = this.branchRows()[this.highlighted()];
      return row && selectableBranch(row) ? row : null;
    }
    const picked = this.pickedBranch();
    if (picked) return picked;
    const row = this.branchRows()[0];
    return this.branchValue().trim() && row && selectableBranch(row) ? row : null;
  });
  private readonly baseSelection = computed(() => {
    if (this.currentStep() === "base") return this.baseRows()[this.highlighted()];
    const picked = this.pickedBase();
    return this.baseBranches().find(branch => picked ? branchRef(branch) === picked : branch.isDefault);
  });
  protected readonly baseLabel = computed(
    () => this.baseSelection()?.name ?? shortBranchName(this.pickedBase() ?? this.defaultBase()),
  );
  protected readonly baseIsDefault = computed(
    () => !!this.baseSelection()?.isDefault || this.pickedBase() === this.defaultBase(),
  );
  protected readonly workspaceValue = computed(
    () => this.pickedWorkspace() ?? this.workspace(),
  );
  protected readonly existing = computed(
    () => this.branch()?.kind === "branch",
  );
  protected readonly branchLookupBlocked = computed(() => this.branchesLoading() || this.branchSearchFailed());
  protected readonly canPlan = computed(() => this.active() && !this.branchLookupBlocked() && !!this.titleValue().trim());
  protected readonly canCreate = computed(
    () => this.canPlan() && this.branchAvailable() && (this.existing() || !!this.baseSelection()),
  );
  protected readonly canNext = computed(() => {
    if (!this.active()) return false;
    switch (this.currentStep()) {
      case "name":
        return !!this.titleValue().trim();
      case "repo":
        return !!this.repos()[this.highlighted()];
      case "branch": return !this.branchLookupBlocked() && this.branchAvailable();
      case "base": return this.canCreate();
    }
  });
  private readonly branchAvailable = computed(() => {
    const chosen = this.branch();
    if (!chosen) return false;
    if (chosen.kind === "branch") {
      return this.currentBranches().some(
        branch => branchRef(branch) === branchRef(chosen) && !branch.task,
      );
    }
    return validBranchName(chosen.name) &&
      !this.currentBranches().some(branch => !branch.remote && branch.name === chosen.name);
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
  protected readonly branchRefLimit = WORKSPACE_BRANCH_REF_LIMIT;
  private readonly injector = inject(Injector);
  private readonly projectTrigger = viewChild(CdkMenuTrigger);
  private readonly branchRequest = computed<TaskBranchSearch | null>(() => {
    const repo = this.currentRepo(), step = this.currentStep();
    // Existing branches keep their history; loading unused bases would disable
    // Create just as the From step hands keyboard focus to that button.
    if (!this.active() || this.waitingFor() || !repo || (step !== "branch" && step !== "base") || (step === "base" && this.existing())) return null;
    return { repoId: repo.id, query: step === "base" ? this.baseQueryValue() : this.branchValue(), kind: step };
  }, { equal: (previous, next) => previous?.repoId === next?.repoId && previous?.query === next?.query && previous?.kind === next?.kind });
  constructor() {
    afterRenderEffect(() => {
      if (!this.active() || !this.projectMenu()) this.projectTrigger()?.close();
    });
    effect(() => {
      const request = this.branchRequest();
      untracked(() => this.branchQueryRequested.emit(request));
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
    let index = 0;
    if (step === "repo") index = this.repos().findIndex(repo => repo.id === this.currentRepo()?.id);
    if (step === "branch") {
      const picked = this.pickedBranch();
      if (picked) index = this.branchRows().findIndex(row => row.kind === picked.kind && branchRef(row) === branchRef(picked));
    }
    if (step === "base") index = this.baseRows().findIndex(row => branchRef(row) === this.pickedBase());
    this.highlighted.set(Math.max(0, index));
    afterNextRender(() => this.focusCurrent(), { injector: this.injector });
  }
  protected activeOption(step: "branch" | "base"): string | null {
    if (this.currentStep() !== step || this.branchLookupBlocked()) return null;
    const row = (step === "branch" ? this.branchRows() : this.baseRows())[this.highlighted()];
    return row && selectableBranch(row, step === "base")
      ? (step === "branch" ? this.branchListId : this.baseListId) + "-" + this.highlighted()
      : null;
  }
  protected retryBranchSearch(): void {
    const request = this.branchRequest();
    if (request) {
      this.focusCurrent();
      this.branchQueryRequested.emit(request);
    }
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
    if (this.currentRepo()?.id !== id) {
      this.pickedBranch.set(null);
      this.pickedBase.set(null);
      this.baseQueryValue.set("");
    }
    this.pickedRepo.set(id);
    this.go("branch");
  }
  protected pickBranch(row: BranchRow): void {
    if (!this.active() || this.branchLookupBlocked() || !selectableBranch(row)) return;
    this.pickedBranch.set(row);
    this.go("base");
  }
  protected pickBase(row: BranchRow): void {
    if (!this.active() || this.branchLookupBlocked() || row.kind !== "branch") return;
    const index = this.baseRows().indexOf(row);
    if (index < 0) return;
    this.highlighted.set(index);
    this.pickedBase.set(branchRef(row));
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
    const base = this.baseSelection();
    if (!this.canCreate() || !branch) return;
    this.create.emit({
      ...(this.multipleRepos() ? { repo: this.currentRepo()?.id } : {}),
      title: this.titleValue().trim(),
      branch: branchRef(branch),
      existing: branch.kind === "branch",
      base: branch.kind === "branch" || !base ? null : branchRef(base),
      workspace: this.workspaceValue(),
    });
  }
  protected savePlanned(): void {
    if (!this.canPlan()) return;
    const branch = this.branchAvailable() ? this.branch() : null;
    const base = this.baseSelection();
    this.plan.emit({
      ...(this.multipleRepos() ? { repo: this.currentRepo()?.id } : {}),
      title: this.titleValue().trim(),
      branch: branch ? branchRef(branch) : undefined,
      existing: branch?.kind === "branch",
      base: branch?.kind === "branch" || !base ? undefined : branchRef(base),
      workspace: this.workspaceValue(),
    });
  }
  protected onKey(event: KeyboardEvent): void {
    if (!this.active()) return;
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
      if (this.currentStep() !== "repo" && this.branchLookupBlocked()) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      let next = Math.min(this.highlighted(), rows.length) + direction;
      while (next >= 0 && next < rows.length) {
        const row = rows[next];
        if (row && (!("kind" in row) || selectableBranch(row, this.currentStep() === "base"))) {
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
