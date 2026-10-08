import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, combineLatest, distinctUntilChanged, map, of, switchMap } from 'rxjs';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import { ZardInputDirective } from '@/shared/components/input';
import { NavigationService } from '@/shared/services/navigation.service';
import { Task, taskError } from './task.model';
import { TaskUiService } from './task-ui.service';
import { TasksApiService } from './tasks-api.service';
import { toast } from 'ngx-sonner';

@Component({
  selector: 'app-task-header',
  imports: [ZardButtonComponent, ZardInputDirective, RouterLink],
  templateUrl: './task-header.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskHeaderComponent {
  readonly taskId = input<number | null | undefined>();
  readonly task = signal<Task | null>(null);
  readonly editing = signal(false);
  readonly saving = signal(false);
  readonly taskUi = inject(TaskUiService);
  private readonly api = inject(TasksApiService);
  private readonly navigation = inject(NavigationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  constructor() {
    afterRenderEffect(() => {
      const input = this.nameInput()?.nativeElement;
      if (this.editing() && input) {
        input.focus();
        input.select();
      }
    });
    combineLatest([toObservable(this.taskId), toObservable(this.navigation.tree)])
      .pipe(
        map(([id, tree]) => {
          const task = tree
            .flatMap((project) => project.repos)
            .flatMap((repo) => repo.workspaces ?? [])
            .find((task) => task.id === id);
          return {
            id,
            signature: task
              ? `${task.name}:${task.taskState}:${task.currentBranch}:${task.archivedAt}`
              : '',
          };
        }),
        distinctUntilChanged((a, b) => a.id === b.id && a.signature === b.signature),
        switchMap(({ id }) => {
          this.task.set(null);
          this.editing.set(false);
          return id ? this.api.get(id).pipe(catchError(() => of(null))) : of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((task) => this.task.set(task));
  }
  rename(name: string) {
    const task = this.task();
    if (!task || this.saving() || !this.editing()) return;
    if (!name.trim() || name.trim() === task.name) {
      this.editing.set(false);
      return;
    }
    this.saving.set(true);
    this.api
      .rename(task.id, name)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (task) => {
          this.task.set(task);
          this.editing.set(false);
          this.saving.set(false);
          this.navigation.refreshTree();
        },
        error: (error) => {
          this.saving.set(false);
          toast.error(taskError(error));
        },
      });
  }
}
