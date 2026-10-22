import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  ButtonComponent,
  FoldComponent,
  IconComponent,
  KbdComponent,
} from '../../ui';
import type {
  BranchInfo,
  BranchRow,
  CreatedTask,
  PlannedTask,
  ProjectMark,
  TaskLink,
  Workspace,
} from '../task.models';
import { ProjectMarkComponent } from '../projects/project-mark.component';
import { LinkChipComponent } from '../lifecycle/link-chip.component';
import { BranchPickerComponent } from './branch-picker.component';
import { WorkspacePickerComponent } from './workspace-picker.component';
import {
  branchFromTitle,
  branchItems,
  selectableBranch,
  validBranchName,
} from './branch-options';

export type NewTaskStep = 'name' | 'branch' | 'base';

@Component({
  selector: 'ex-new-task',
  imports: [
    ButtonComponent,
    FoldComponent,
    IconComponent,
    KbdComponent,
    ProjectMarkComponent,
    LinkChipComponent,
    BranchPickerComponent,
    WorkspacePickerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './new-task.component.html',
  styleUrl: './new-task.component.css',
})
export class NewTaskComponent implements OnInit {
  readonly project = input.required<ProjectMark>();
  readonly branches = input<readonly BranchInfo[]>([]);
  readonly bases = input<readonly BranchInfo[]>();
  readonly base = input('main');
  readonly branchPrefix = input('');
  /** Initial form values are read once. Recreate the form for a different draft. */
  readonly title = input('');
  readonly step = input<NewTaskStep>('name');
  readonly branchQuery = input<string>();
  readonly workspace = input('auto');
  readonly workspaces = input<readonly Workspace[]>([]);
  readonly links = input<readonly TaskLink[]>([]);
  readonly autoFocus = input(true);
  readonly create = output<CreatedTask>();
  readonly plan = output<PlannedTask>();
  readonly cancelled = output<void>();
  readonly linkRequested = output<void>();
  readonly projectRequested = output<void>();
  readonly workspaceRequested = output<'new' | 'manage'>();
  protected readonly titleValue = signal('');
  protected readonly currentStep = signal<NewTaskStep>('name');
  protected readonly branchQueryValue = signal<string | null>(null);
  protected readonly baseQuery = signal('');
  protected readonly highlighted = signal(0);
  protected readonly pickedBranch = signal<BranchRow | null>(null);
  protected readonly pickedBase = signal<string | null>(null);
  protected readonly pickedWorkspace = signal<string | null>(null);
  protected readonly branchValue = computed(
    () =>
      this.branchQueryValue() ??
      branchFromTitle(this.titleValue(), this.branchPrefix()),
  );
  protected readonly branchRows = computed(() =>
    branchItems(this.branchValue(), this.branches(), true),
  );
  protected readonly baseBranches = computed(() =>
    (this.bases() ?? this.branches())
      .filter((branch) => !branch.task)
      .map((branch) => ({ ...branch, isDefault: branch.name === this.base() })),
  );
  protected readonly baseRows = computed(() =>
    branchItems(this.baseQuery(), this.baseBranches()),
  );
  protected readonly branch = computed(() => {
    const picked = this.pickedBranch();
    if (picked) return picked;
    const row =
      this.branchRows()[
        this.currentStep() === 'branch' ? this.highlighted() : 0
      ];
    return this.branchValue().trim() && row && selectableBranch(row)
      ? row
      : null;
  });
  protected readonly baseValue = computed(
    () => this.pickedBase() ?? this.base(),
  );
  protected readonly workspaceValue = computed(
    () => this.pickedWorkspace() ?? this.workspace(),
  );
  protected readonly existing = computed(
    () => this.branch()?.kind === 'branch',
  );
  protected readonly canCreate = computed(
    () =>
      !!this.titleValue().trim() &&
      !!this.branch() &&
      this.branchAvailable() &&
      (this.existing() ||
        this.baseBranches().some((branch) => branch.name === this.baseValue())),
  );
  protected readonly branchAvailable = computed(() => {
    const chosen = this.branch();
    if (!chosen) return false;
    const current = this.branches().find(
      (branch) => branch.name === chosen.name,
    );
    return chosen.kind === 'branch'
      ? !!current && !current.task
      : !current && validBranchName(chosen.name);
  });
  protected readonly nameField =
    viewChild<ElementRef<HTMLInputElement>>('nameField');
  protected readonly branchField =
    viewChild<ElementRef<HTMLInputElement>>('branchField');
  protected readonly baseField =
    viewChild<ElementRef<HTMLInputElement>>('baseField');
  protected readonly branchListId = `new-task-branches-${crypto.randomUUID()}`;
  protected readonly baseListId = `new-task-bases-${crypto.randomUUID()}`;
  private readonly injector = inject(Injector);
  constructor() {
    afterNextRender(() => {
      if (this.autoFocus()) this.focusCurrent();
    });
  }
  ngOnInit(): void {
    this.titleValue.set(this.title());
    this.currentStep.set(this.step());
    this.branchQueryValue.set(this.branchQuery() ?? null);
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
    this.baseQuery.set(value);
    this.highlighted.set(0);
  }
  protected go(step: NewTaskStep): void {
    this.currentStep.set(step);
    this.highlighted.set(0);
    afterNextRender(() => this.focusCurrent(), { injector: this.injector });
  }
  protected state(step: NewTaskStep): 'active' | 'done' | 'todo' | 'skip' {
    if (step === 'base' && this.existing()) return 'skip';
    if (this.currentStep() === step) return 'active';
    const order: readonly NewTaskStep[] = ['name', 'branch', 'base'];
    return order.indexOf(this.currentStep()) > order.indexOf(step)
      ? 'done'
      : 'todo';
  }
  protected pickBranch(row: BranchRow): void {
    if (!selectableBranch(row)) return;
    this.pickedBranch.set(row);
    if (row.kind === 'branch') this.submit();
    else this.go('base');
  }
  protected pickBase(row: BranchRow): void {
    if (!selectableBranch(row) || row.kind !== 'branch') return;
    this.pickedBase.set(row.name);
    this.submit();
  }
  protected submit(): void {
    const branch = this.branch();
    if (!this.canCreate() || !branch) return;
    this.create.emit({
      title: this.titleValue().trim(),
      branch: branch.name,
      existing: branch.kind === 'branch',
      base: branch.kind === 'branch' ? null : this.baseValue(),
      workspace: this.workspaceValue(),
    });
  }
  protected savePlanned(): void {
    if (!this.titleValue().trim()) return;
    this.plan.emit({
      title: this.titleValue().trim(),
      branch: this.branch()?.name,
      base: this.existing() ? undefined : this.baseValue(),
      workspace: this.workspaceValue(),
    });
  }
  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelled.emit();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.submit();
      return;
    }
    if (event.key === 'Enter' && event.altKey) {
      event.preventDefault();
      this.savePlanned();
      return;
    }
    if (!(event.target instanceof HTMLInputElement)) return;
    if (
      event.key === 'Tab' &&
      event.shiftKey &&
      this.currentStep() !== 'name'
    ) {
      event.preventDefault();
      this.go(this.currentStep() === 'base' ? 'branch' : 'name');
      return;
    }
    const rows =
      this.currentStep() === 'branch'
        ? this.branchRows()
        : this.currentStep() === 'base'
          ? this.baseRows()
          : null;
    if (rows && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      let next = this.highlighted() + direction;
      while (next >= 0 && next < rows.length) {
        const row = rows[next];
        if (row && selectableBranch(row)) {
          this.highlighted.set(next);
          break;
        }
        next += direction;
      }
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (this.currentStep() === 'name') {
      if (this.titleValue().trim()) this.go('branch');
      return;
    }
    const row = rows?.[this.highlighted()];
    if (!row) return;
    if (this.currentStep() === 'branch') this.pickBranch(row);
    else this.pickBase(row);
  }
  private focusCurrent(): void {
    const field =
      this.currentStep() === 'name'
        ? this.nameField()
        : this.currentStep() === 'branch'
          ? this.branchField()
          : this.baseField();
    field?.nativeElement.focus();
    if (this.currentStep() !== 'name') field?.nativeElement.select();
  }
}
