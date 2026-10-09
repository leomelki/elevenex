import { A11yModule } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import { ZardInputDirective } from '@/shared/components/input';
import { Z_MODAL_DATA } from '@/shared/components/dialog/dialog.service';
import { ZardDialogRef } from '@/shared/components/dialog/dialog-ref';
import { WorktreesService } from '@/shared/services/worktrees.service';
import { WorktreePoolItem } from '@/shared/models/worktree.model';
import { OptionSelectComponent, OptionSelectItem } from '@/shared/components/option-select';
import { catchError, debounceTime, map, of, Subject, switchMap } from 'rxjs';
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
  private requestId = crypto.randomUUID();
  private branchEdited = false;
  readonly mode = signal<'new' | 'existing'>(this.data.mode ?? 'new');
  readonly name = signal('');
  readonly branch = signal(this.data.branch ?? '');
  readonly base = signal('');
  readonly basePicker = signal(false);
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
      badge: item.owner
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
  readonly options = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly canCreate = computed(
    () =>
      !this.busy() &&
      !!this.branch().trim() &&
      (this.mode() === 'existing' || !!this.base().trim()) &&
      (this.environment() !== 'existing' || !!this.worktreeId()),
  );

  constructor() {
    this.api
      .defaults(this.data.repoId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (defaults) => {
          if (!this.base()) this.base.set(defaults.baseRef ?? '');
        },
        error: () => this.error.set('Could not load the default base. Choose a base branch below.'),
      });
    this.names
      .pipe(
        debounceTime(200),
        switchMap((name) =>
          this.api.defaults(this.data.repoId, name).pipe(
            map((defaults) => ({ name, defaults })),
            catchError(() => of(null)),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((result) => {
        if (result && result.name === this.name() && !this.branchEdited && this.mode() === 'new')
          this.branch.set(this.name().trim() ? result.defaults.branchName : '');
      });
  }
  setName(name: string) {
    this.name.set(name);
    if (!this.branchEdited && this.mode() === 'new')
      this.branch.set(name.trim() ? taskSlug(name) : '');
    this.names.next(name);
  }
  setBranch(branch: string) {
    this.branchEdited = true;
    this.branch.set(branch);
  }
  selectEnvironment(value: string) {
    this.environment.set(value as 'automatic' | 'new' | 'existing');
  }
  setMode(mode: 'new' | 'existing') {
    if (mode === this.mode()) return;
    this.mode.set(mode);
    this.branchEdited = false;
    this.error.set('');
    this.branch.set(mode === 'new' && this.name().trim() ? taskSlug(this.name()) : '');
    if (mode === 'new') this.names.next(this.name());
  }
  showOptions() {
    this.options.set(!this.options());
    if (this.options() && !this.environments().length)
      this.worktrees
        .getPoolByRepoStream(this.data.repoId)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (list) => this.environments.set(list),
          error: () =>
            this.environmentsError.set(
              'Could not load worktrees. Automatic selection is available.',
            ),
        });
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
