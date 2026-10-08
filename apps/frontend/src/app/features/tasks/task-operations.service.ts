import { DestroyRef, effect, inject, Injectable, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, exhaustMap, forkJoin, of, timer } from 'rxjs';
import { NavigationService } from '@/shared/services/navigation.service';
import { TasksApiService } from './tasks-api.service';
import { Task } from './task.model';

/** Observe durable operations across route changes, without taking focus on completion. */
@Injectable({ providedIn: 'root' })
export class TaskOperationsService {
  private readonly api = inject(TasksApiService);
  private readonly navigation = inject(NavigationService);
  private readonly pending = new Set<number>();
  constructor() {
    effect(() => {
      const ids = this.navigation
        .tree()
        .flatMap((project) =>
          project.repos.flatMap((repo) =>
            (repo.workspaces ?? [])
              .filter((task) => task.taskState === 'preparing' || task.taskState === 'finishing')
              .map((task) => task.id),
          ),
        );
      untracked(() => ids.forEach((id) => this.pending.add(id)));
    });
    timer(0, 1800)
      .pipe(
        exhaustMap(() => {
          const ids = [...this.pending];
          return ids.length
            ? forkJoin(
                ids.map((id) =>
                  this.api.get(id).pipe(
                    catchError((error) => {
                      if (error.status === 404) this.pending.delete(id);
                      return of(null);
                    }),
                  ),
                ),
              )
            : of([]);
        }),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((tasks) => {
        let changed = false;
        for (const task of tasks) {
          if (task && task.taskState !== 'preparing' && task.taskState !== 'finishing') {
            this.pending.delete(task.id);
            changed = true;
          }
        }
        if (changed) this.navigation.refreshTree();
      });
  }
  track(task: Task) {
    this.pending.add(task.id);
    this.navigation.refreshTree();
  }
}
