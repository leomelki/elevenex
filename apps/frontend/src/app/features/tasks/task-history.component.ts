import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { toObservable, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { catchError, combineLatest, distinctUntilChanged, map, of, switchMap } from 'rxjs';
import { NavigationService } from '@/shared/services/navigation.service';
import { Task } from './task.model';
import { TasksApiService } from './tasks-api.service';

@Component({
  selector: 'app-task-history',
  imports: [RouterLink, DatePipe],
  templateUrl: './task-history.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskHistoryComponent {
  readonly repoId = input.required<number>();
  readonly tasks = signal<Task[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly hasMore = signal(false);
  private readonly api = inject(TasksApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly navigation = inject(NavigationService);
  private generation = 0;
  constructor() {
    combineLatest([toObservable(this.repoId), toObservable(this.navigation.tree)])
      .pipe(
        map(([id, tree]) => ({
          id,
          signature:
            tree
              .flatMap((project) => project.repos)
              .find((repo) => repo.id === id)
              ?.workspaces?.map((task) => task.id)
              .join(',') ?? '',
        })),
        distinctUntilChanged((a, b) => a.id === b.id && a.signature === b.signature),
        switchMap(({ id }) => {
          this.generation++;
          this.loading.set(true);
          this.error.set(false);
          return this.api.list(id, 'finished').pipe(
            catchError(() => {
              this.error.set(true);
              return of([]);
            }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((tasks) => {
        this.tasks.set(tasks);
        this.hasMore.set(tasks.length === 20);
        this.loading.set(false);
      });
  }
  retry() {
    const generation = ++this.generation;
    this.loading.set(true);
    this.error.set(false);
    this.api
      .list(this.repoId(), 'finished')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (tasks) => {
          if (generation !== this.generation) return;
          this.tasks.set(tasks);
          this.hasMore.set(tasks.length === 20);
          this.loading.set(false);
        },
        error: () => {
          if (generation !== this.generation) return;
          this.error.set(true);
          this.loading.set(false);
        },
      });
  }
  loadMore() {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set(false);
    const generation = this.generation;
    this.api
      .list(this.repoId(), 'finished', this.tasks().at(-1)?.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (tasks) => {
          if (generation !== this.generation) return;
          this.tasks.update((current) => [...current, ...tasks]);
          this.hasMore.set(tasks.length === 20);
          this.loading.set(false);
        },
        error: () => {
          if (generation !== this.generation) return;
          this.error.set(true);
          this.loading.set(false);
        },
      });
  }
}
