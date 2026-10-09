import { A11yModule } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
  afterNextRender,
  Injector,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import { ZardInputDirective } from '@/shared/components/input';
import { Z_MODAL_DATA } from '@/shared/components/dialog/dialog.service';
import { ZardDialogRef } from '@/shared/components/dialog/dialog-ref';
import { WorktreesService } from '@/shared/services/worktrees.service';
import { WorktreePoolItem } from '@/shared/models/worktree.model';
import { BranchInfo } from '@/shared/models/branch.model';
import { OptionSelectComponent, OptionSelectItem } from '@/shared/components/option-select';
import { catchError, map, of, Subject, switchMap, timer } from 'rxjs';
import { TaskBranchPickerComponent } from './branch-picker.component';
import { TasksApiService } from './tasks-api.service';
import { TaskOperationsService } from './task-operations.service';
import { taskError, taskSlug } from './task.model';
import { BranchRefPipe } from './branch-ref.pipe';

export interface TaskCreateData {
  repoId: number;
  repoName: string;
  mode?: 'new' | 'existing';
  branch?: string;
}

@Component({
  selector: 'app-task-create',
  imports: [
    A11yModule,
    ZardButtonComponent,
    ZardInputDirective,
    TaskBranchPickerComponent,
    OptionSelectComponent,
    BranchRefPipe,
  ],
  templateUrl: './task-create.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskCreateComponent {
  readonly data: TaskCreateData = inject(Z_MODAL_DATA);
  private readonly api = inject(TasksApiService);
  private readonly operations = inject(TaskOperationsService);
  private readonly router = inject(Router);
  private readonly dialog = inject(ZardDialogRef);
  private readonly worktrees = inject(WorktreesService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly names = new Subject<string>();
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly picker = viewChild(TaskBranchPickerComponent);
  private environmentsRequested = false;
  private requestId = crypto.randomUUID();
  private branchEdited = false;
  readonly mode = signal<'new' | 'existing'>(this.data.mode ?? 'new');
  readonly step = signal<'setup' | 'branch' | 'base'>('setup');
  readonly name = signal('');
  readonly branch = signal(this.data.branch ?? '');
  readonly base = signal('');
  readonly defaultBase = signal('');
  readonly branchQuery = signal(this.data.branch?.replace(/^refs\/(heads|remotes)\//, '') ?? '');
  readonly baseQuery = signal('');
  readonly customReference = signal(false);
  readonly defaultsLoading = signal(true);
  readonly suggestionLoading = signal(false);
  readonly environment = signal<'automatic' | 'new' | 'existing'>('automatic');
  readonly worktreeId = signal<number | undefined>(undefined);
  readonly environments = signal<WorktreePoolItem[]>([]);
  readonly environmentOptions: OptionSelectItem[] = [
    {
      value: 'automatic',
      label: 'Automatic',
      badge: 'Recommended',
      description: 'Reuse a clean available worktree, or create one.',
    },
    { value: 'new', label: 'Create a new worktree' },
    { value: 'existing', label: 'Choose an existing worktree' },
  ];
  readonly availableEnvironments = computed<OptionSelectItem[]>(() =>
    this.environments().map((item) => ({
      value: String(item.id),
      label: item.name,
      description: item.path,
      badge: item.isMissing
        ? 'Missing'
        : item.isLocked
          ? 'Locked'
          : item.hasConflicts
            ? 'Conflicts'
            : item.owner
              ? 'In use'
              : item.isDirty
                ? 'Local edits'
                : item.statusLoading
                  ? 'Checking…'
                  : undefined,
      disabled:
        !!item.owner ||
        item.isDirty ||
        item.hasConflicts ||
        item.isLocked ||
        item.isMissing ||
        item.statusLoading,
    })),
  );
  readonly environmentsError = signal('');
  readonly environmentsLoading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly canCreate = computed(
    () =>
      !this.busy() &&
      !!this.branch().trim() &&
      (this.mode() === 'existing' || !!this.base().trim()) &&
      this.canContinue(),
  );
  readonly canContinue = computed(
    () =>
      !this.busy() &&
      (this.environment() !== 'existing' ||
        this.availableEnvironments().some(
          (item) => item.value === String(this.worktreeId()) && !item.disabled,
        )),
  );
  readonly worktreeLabel = computed(() =>
    this.environment() === 'existing'
      ? (this.environments().find((item) => item.id === this.worktreeId())?.name ??
        'Existing worktree')
      : this.environment() === 'new'
        ? 'New worktree'
        : 'Automatic worktree',
  );
  readonly noAvailableWorktrees = computed(
    () =>
      !this.environmentsLoading() &&
      !this.environmentsError() &&
      !this.availableEnvironments().some((item) => !item.disabled),
  );
  readonly canSubmit = computed(() => {
    if (this.step() === 'setup') return this.canContinue();
    if (this.step() === 'base' && this.customReference()) return this.canCreate();
    const picker = this.picker();
    return (
      !this.busy() &&
      (this.step() !== 'base' || (!this.defaultsLoading() && this.canContinue())) &&
      (this.step() !== 'branch' || !this.suggestionLoading()) &&
      !!picker &&
      (!picker.loading() || picker.options()[picker.index()]?.kind === 'default') &&
      !!picker.options()[picker.index()]
    );
  });
  readonly submitLabel = computed(() => {
    if (this.busy()) return 'Creating…';
    if (this.step() === 'base') return 'Create task';
    const picker = this.picker();
    return this.step() === 'branch' && picker?.options()[picker.index()]?.kind === 'branch'
      ? 'Create task'
      : 'Continue';
  });

  constructor() {
    this.api
      .defaults(this.data.repoId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (defaults) => {
          this.defaultBase.set(defaults.baseRef ?? '');
          if (!this.base()) this.base.set(defaults.baseRef ?? '');
          if (!this.branch() && this.mode() === 'new') this.branch.set(defaults.branchName);
          this.defaultsLoading.set(false);
        },
        error: () => {
          this.defaultsLoading.set(false);
          this.error.set('Could not load the default base. Choose a base branch in the last step.');
        },
      });
    this.names
      .pipe(
        switchMap((name) =>
          timer(200).pipe(
            switchMap(() => this.api.defaults(this.data.repoId, name)),
            map((defaults) => ({ name, defaults })),
            catchError(() => of({ name, defaults: null })),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((result) => {
        if (result.name !== this.name()) return;
        this.suggestionLoading.set(false);
        if (result.defaults && !this.branchEdited && this.mode() === 'new') {
          this.branch.set(result.defaults.branchName);
          if (this.step() === 'branch') this.branchQuery.set(result.defaults.branchName);
        }
      });
  }
  setName(name: string) {
    this.name.set(name);
    if (!this.branchEdited && this.mode() === 'new') this.branch.set(taskSlug(name));
    this.suggestionLoading.set(!this.branchEdited && this.mode() === 'new');
    this.names.next(name);
  }
  setBranch(branch: string) {
    this.branchEdited = true;
    this.branch.set(branch);
  }
  selectEnvironment(value: string) {
    this.environment.set(value as 'automatic' | 'new' | 'existing');
    if (value === 'existing') this.loadEnvironments();
  }
  setMode(mode: 'new' | 'existing') {
    if (mode === this.mode()) return;
    this.mode.set(mode);
    this.branchEdited = false;
    this.error.set('');
    this.branch.set(mode === 'new' ? taskSlug(this.name()) : '');
    if (mode === 'new') this.names.next(this.name());
  }
  private loadEnvironments() {
    if (this.environmentsRequested) return;
    this.environmentsRequested = true;
    this.environmentsLoading.set(true);
    this.environmentsError.set('');
    this.worktrees
      .getPoolByRepoStream(this.data.repoId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => this.environments.set(list),
        complete: () => this.environmentsLoading.set(false),
        error: () => {
          this.environmentsLoading.set(false);
          this.environmentsRequested = false;
          this.environmentsError.set('Could not load worktrees. Automatic selection is available.');
        },
      });
  }
  continue() {
    if (!this.canContinue()) return;
    if (!this.branchEdited) {
      this.branchQuery.set(
        this.branch().replace(/^refs\/(heads|remotes)\//, '') ||
          (this.mode() === 'new' ? taskSlug(this.name()) : ''),
      );
    }
    this.step.set('branch');
  }
  editBranchQuery(value: string) {
    this.branchEdited = true;
    this.suggestionLoading.set(false);
    this.branchQuery.set(value);
  }
  chooseNewBranch(name: string) {
    if (this.busy()) return;
    this.mode.set('new');
    this.setBranch(name);
    this.branchQuery.set(name);
    this.step.set('base');
  }
  chooseExistingBranch(branch: BranchInfo) {
    if (this.busy()) return;
    this.mode.set('existing');
    this.setBranch((branch.isRemote ? 'refs/remotes/' : 'refs/heads/') + branch.name);
    this.create();
  }
  chooseBase(ref: string) {
    this.base.set(ref);
    this.create();
  }
  back() {
    if (this.busy()) return;
    this.error.set('');
    const step = this.step();
    this.step.set(step === 'base' ? 'branch' : 'setup');
    if (step === 'branch')
      afterNextRender(
        () => this.element.nativeElement.querySelector<HTMLInputElement>('#task-name')?.focus(),
        { injector: this.injector },
      );
  }
  toggleCustomReference() {
    this.customReference.set(!this.customReference());
    afterNextRender(
      () =>
        this.element.nativeElement
          .querySelector<HTMLInputElement>(
            this.customReference() ? '#task-base-ref' : '#task-branch-search',
          )
          ?.focus(),
      { injector: this.injector },
    );
  }
  submit() {
    if (this.step() === 'setup') this.continue();
    else if (this.step() === 'base' && this.customReference()) this.create();
    else this.picker()?.activate();
  }
  cancel() {
    this.dialog.close();
  }
  create() {
    if (!this.canCreate()) return;
    this.busy.set(true);
    this.error.set('');
    this.api
      .create(this.data.repoId, {
        requestId: this.requestId,
        name: this.name().trim(),
        mode: this.mode(),
        branchName: this.branch().trim(),
        baseRef: this.mode() === 'new' ? this.base().trim() : undefined,
        environment: this.environment(),
        worktreeId: this.worktreeId(),
        confirmExternal: this.environment() === 'existing',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (task) => {
          this.operations.track(task);
          void this.router.navigate(['/tasks', task.id]);
          this.dialog.close();
        },
        error: (error) => {
          this.busy.set(false);
          this.error.set(taskError(error));
        },
      });
  }
}
