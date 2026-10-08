import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import { ZardInputDirective } from '@/shared/components/input';
import { NavigationService } from '@/shared/services/navigation.service';
import {
  catchError,
  debounceTime,
  exhaustMap,
  firstValueFrom,
  of,
  Subject,
  switchMap,
  timer,
  merge,
  takeWhile,
} from 'rxjs';
import { Task, TaskSetup, taskError } from './task.model';
import { TasksApiService } from './tasks-api.service';
import { TaskOperationsService } from './task-operations.service';
import { TaskUiService } from './task-ui.service';
import { TaskDraftService } from './task-draft.service';
import { BranchRefPipe } from './branch-ref.pipe';

@Component({
  selector: 'app-task-detail',
  imports: [ZardButtonComponent, ZardInputDirective, RouterLink, DatePipe, BranchRefPipe],
  templateUrl: './task-detail.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskDetailComponent {
  readonly taskUi = inject(TaskUiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(TasksApiService);
  private readonly draftStore = inject(TaskDraftService);
  private readonly operations = inject(TaskOperationsService);
  private readonly navigation = inject(NavigationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reload = new Subject<void>();
  private readonly drafts = new Subject<{ id: number; text: string }>();
  private opening = false;
  private loadedId = 0;
  private savedDraft = '';
  readonly task = signal<Task | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly draft = signal('');
  readonly draftSaving = signal(false);
  readonly draftUnsaved = signal(false);
  readonly branch = signal('');
  readonly base = signal('');
  constructor() {
    this.destroyRef.onDestroy(() => this.flushDraft());
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.reload.next());
    this.route.paramMap
      .pipe(
        switchMap((params) => {
          this.flushDraft();
          this.task.set(null);
          this.error.set('');
          this.opening = false;
          this.loadedId = Number(params.get('id'));
          return merge(of(undefined), this.reload).pipe(
            switchMap(() =>
              timer(0, 1500).pipe(
                exhaustMap(() =>
                  this.api.get(this.loadedId).pipe(
                    catchError((error) => {
                      this.error.set(taskError(error));
                      return of(null);
                    }),
                  ),
                ),
                takeWhile(
                  (task) =>
                    !!task &&
                    (task.taskState === 'preparing' ||
                      task.taskState === 'finishing' ||
                      (task.taskState === 'ready' && !task.archivedAt && !task.sessions.length)),
                  true,
                ),
              ),
            ),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((task) => {
        if (!task) return;
        const first = this.task()?.id !== task.id;
        this.task.set(task);
        if (first) {
          this.draftSaving.set(false);
          this.draftUnsaved.set(false);
          this.draft.set(task.taskDraft || '');
          this.savedDraft = task.taskDraft || '';
          const setup = this.setup(task);
          this.branch.set(setup.branchName || task.taskBranch || '');
          this.base.set(setup.baseRef || '');
        }
        if (task.taskState === 'ready' && !task.archivedAt && !this.opening)
          void this.openSession(task);
      });
    this.drafts
      .pipe(debounceTime(350), takeUntilDestroyed(this.destroyRef))
      .subscribe((draft) => this.saveDraft(draft.id, draft.text));
  }
  private saveDraft(id: number, text: string) {
    void this.draftStore.save(id, text).then(
      () => {
        if (this.loadedId === id && this.draft() === text) {
          this.savedDraft = text;
          this.draftSaving.set(false);
          this.draftUnsaved.set(false);
        }
      },
      (error) => {
        if (this.loadedId === id) {
          this.error.set('Could not save your draft. ' + taskError(error));
          this.draftSaving.set(false);
          this.draftUnsaved.set(true);
        }
      },
    );
  }
  private flushDraft() {
    const task = this.task();
    if (task && !task.archivedAt && this.draft() !== this.savedDraft)
      this.saveDraft(task.id, this.draft());
  }
  reloadTask() {
    this.error.set('');
    this.reload.next();
  }
  private setup(task: Task): Partial<TaskSetup> {
    try {
      return JSON.parse(task.taskConfig || '{}');
    } catch {
      return {};
    }
  }
  private async openSession(task: Task) {
    this.opening = true;
    try {
      const session =
        [...task.sessions].reverse().find((session) => session.status !== 'archived') ??
        (await firstValueFrom(this.api.conversation(task.id)));
      // Flush the latest text before opening the composer; preparation never sends it.
      if (this.draft() !== this.savedDraft) await this.draftStore.save(task.id, this.draft());
      if (!this.destroyRef.destroyed && this.loadedId === task.id) {
        this.navigation.refreshTree();
        await this.router.navigate(['/sessions', session.id], { replaceUrl: true });
      }
    } catch (error) {
      this.error.set(taskError(error));
      this.opening = false;
    }
  }
  setDraft(text: string) {
    const task = this.task();
    if (!task) return;
    this.draft.set(text);
    this.draftSaving.set(true);
    this.drafts.next({ id: task.id, text });
  }
  retryDraft() {
    const task = this.task();
    if (!task || this.draftSaving()) return;
    this.error.set('');
    this.draftSaving.set(true);
    this.saveDraft(task.id, this.draft());
  }
  retry(patch: Partial<TaskSetup> = {}) {
    const task = this.task();
    if (!task || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.api
      .retry(task.id, patch)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (task) => {
          this.task.set(task);
          this.operations.track(task);
          this.busy.set(false);
          this.reload.next();
        },
        error: (error) => {
          this.error.set(taskError(error));
          this.busy.set(false);
        },
      });
  }
  reopen() {
    const task = this.task();
    if (!task || this.busy()) return;
    this.busy.set(true);
    this.api
      .reopen(task.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (task) => {
          this.task.set(task);
          this.operations.track(task);
          this.busy.set(false);
          this.reload.next();
        },
        error: (error) => {
          this.error.set(taskError(error));
          this.busy.set(false);
        },
      });
  }
}
