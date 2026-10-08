import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ZardInputDirective } from '@/shared/components/input';
import { BranchesService } from '@/shared/services/branches.service';
import { BranchInfo } from '@/shared/models/branch.model';
import { BranchRefPipe } from './branch-ref.pipe';
import { catchError, forkJoin, of, Subject, switchMap, timer } from 'rxjs';

@Component({
  selector: 'app-task-branch-picker',
  imports: [ZardInputDirective, BranchRefPipe],
  templateUrl: './branch-picker.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskBranchPickerComponent {
  readonly repoId = input.required<number>();
  readonly selected = input('');
  readonly label = input('Branch');
  readonly picked = output<BranchInfo>();
  readonly confirmed = output<void>();
  readonly branches = signal<BranchInfo[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly query = signal('');
  readonly index = signal(0);
  private readonly api = inject(BranchesService);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly searches = new Subject<{ id: number; query: string }>();
  constructor() {
    this.searches
      .pipe(
        switchMap(({ id, query }) =>
          timer(140).pipe(
            switchMap(() => {
              this.loading.set(true);
              this.error.set('');
              return forkJoin([
                this.api.searchBranches(id, query, true),
                this.api.searchRemoteBranches(id, query),
              ]).pipe(
                catchError(() => {
                  this.error.set('Could not load branches. Change the search to try again.');
                  return of([[], []] as BranchInfo[][]);
                }),
              );
            }),
          ),
        ),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(([local, remote]) => {
        this.branches.set([
          ...local.slice(0, 100),
          ...remote.filter((branch) => !branch.name.endsWith('/HEAD')).slice(0, 100),
        ]);
        this.index.set(0);
        this.loading.set(false);
      });
    effect(() => {
      this.loading.set(true);
      this.searches.next({ id: this.repoId(), query: this.query() });
    });
  }
  isSelected(branch: BranchInfo) {
    return (
      this.selected() === branch.name ||
      this.selected() === (branch.isRemote ? 'refs/remotes/' : 'refs/heads/') + branch.name
    );
  }
  search(value: string) {
    this.query.set(value);
  }
  key(event: KeyboardEvent) {
    const list = this.branches();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.index.set(
        Math.max(0, Math.min(list.length - 1, this.index() + (event.key === 'ArrowDown' ? 1 : -1))),
      );
      this.element.nativeElement
        .querySelector(`#task-branch-option-${this.index()}`)
        ?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!this.loading() && list[this.index()]) {
        const branch = list[this.index()];
        if (this.isSelected(branch)) this.confirmed.emit();
        else this.picked.emit(branch);
      }
    }
  }
}
