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
  computed,
  afterNextRender,
  Injector,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ZardInputDirective } from '@/shared/components/input';
import { BranchesService } from '@/shared/services/branches.service';
import { BranchInfo } from '@/shared/models/branch.model';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideGitBranch, lucideGlobe2, lucidePlus, lucideCheck } from '@ng-icons/lucide';
import { BranchRefPipe } from './branch-ref.pipe';
import { catchError, forkJoin, of, Subject, switchMap, timer } from 'rxjs';

type BranchOption =
  | { kind: 'create'; name: string }
  | { kind: 'default'; ref: string }
  | { kind: 'branch'; branch: BranchInfo };

@Component({
  selector: 'app-task-branch-picker',
  imports: [ZardInputDirective, BranchRefPipe, NgIcon],
  templateUrl: './branch-picker.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideGitBranch, lucideGlobe2, lucidePlus, lucideCheck })],
})
export class TaskBranchPickerComponent {
  readonly repoId = input.required<number>();
  readonly selected = input('');
  readonly label = input('Branch');
  readonly initialQuery = input('');
  readonly allowCreate = input(false);
  readonly recommendedRef = input('');
  readonly disabled = input(false);
  readonly selectionPending = input(false);
  readonly autofocus = input(false);
  readonly picked = output<BranchInfo>();
  readonly confirmed = output<void>();
  readonly createRequested = output<string>();
  readonly referencePicked = output<string>();
  readonly queryChange = output<string>();
  readonly branches = signal<BranchInfo[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly query = signal('');
  readonly index = signal(0);
  private readonly api = inject(BranchesService);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private autofocusPending = true;
  private readonly searches = new Subject<{ id: number; query: string }>();
  readonly canCreate = computed(() => {
    const name = this.query().trim();
    return (
      this.allowCreate() &&
      !!name &&
      !this.loading() &&
      !this.error() &&
      !this.branches().some(
        (branch) =>
          branch.name.toLowerCase() === name.toLowerCase() ||
          (branch.isRemote &&
            branch.name.slice(branch.name.indexOf('/') + 1).toLowerCase() === name.toLowerCase()),
      )
    );
  });
  readonly options = computed<BranchOption[]>(() => {
    const ref = this.recommendedRef();
    const showDefault = ref && ref.toLowerCase().includes(this.query().trim().toLowerCase());
    return [
      ...(this.canCreate() ? [{ kind: 'create' as const, name: this.query().trim() }] : []),
      ...(showDefault ? [{ kind: 'default' as const, ref }] : []),
      ...this.branches()
        .filter((branch) => !showDefault || !this.matchesRef(branch, ref))
        .map((branch) => ({ kind: 'branch' as const, branch })),
    ];
  });
  constructor() {
    this.searches
      .pipe(
        switchMap(({ id, query }) =>
          timer(140).pipe(
            switchMap(() =>
              forkJoin([
                this.api.searchBranches(id, query, true),
                this.api.searchRemoteBranches(id, query),
              ]).pipe(
                catchError(() => {
                  this.error.set('Could not load branches. Change the search to try again.');
                  return of([[], []] as BranchInfo[][]);
                }),
              ),
            ),
          ),
        ),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(([local, remote]) => {
        this.branches.set([
          ...local.slice(0, 100),
          ...remote.filter((branch) => !branch.name.endsWith('/HEAD')).slice(0, 100),
        ]);
        this.loading.set(false);
        const selectedIndex = this.options().findIndex((option) => this.optionSelected(option));
        this.index.set(selectedIndex >= 0 ? selectedIndex : 0);
      });
    effect(() => this.query.set(this.initialQuery()));
    effect(() => {
      const request = { id: this.repoId(), query: this.query() };
      this.loading.set(true);
      this.error.set('');
      this.searches.next(request);
    });
    effect(() => {
      if (!this.autofocus() || this.disabled() || !this.autofocusPending) return;
      afterNextRender(
        () => {
          if (this.disabled()) return;
          this.autofocusPending = false;
          this.element.nativeElement.querySelector<HTMLInputElement>('input')?.focus();
        },
        { injector: this.injector },
      );
    });
  }
  private matchesRef(branch: BranchInfo, ref: string) {
    return ref === branch.name || ref === this.branchRef(branch);
  }
  branchRef(branch: BranchInfo) {
    return (branch.isRemote ? 'refs/remotes/' : 'refs/heads/') + branch.name;
  }
  isSelected(branch: BranchInfo) {
    return this.matchesRef(branch, this.selected());
  }
  optionSelected(option: BranchOption) {
    return option.kind === 'default'
      ? this.selected() === option.ref
      : option.kind === 'branch' && this.isSelected(option.branch);
  }
  optionKey(option: BranchOption) {
    return option.kind === 'branch'
      ? this.branchRef(option.branch)
      : option.kind === 'default'
        ? option.ref
        : 'create';
  }
  search(value: string) {
    this.loading.set(true);
    this.query.set(value);
    this.queryChange.emit(value);
  }
  choose(option: BranchOption) {
    if (this.disabled() || this.selectionPending() || (this.loading() && option.kind !== 'default'))
      return;
    if (option.kind === 'create') this.createRequested.emit(option.name);
    else if (option.kind === 'default') this.referencePicked.emit(option.ref);
    else this.picked.emit(option.branch);
  }
  activate() {
    const option = this.options()[this.index()];
    if (!option || this.disabled() || this.selectionPending()) return;
    if (option.kind === 'branch' && this.isSelected(option.branch) && !this.loading())
      this.confirmed.emit();
    else this.choose(option);
  }
  key(event: KeyboardEvent) {
    const list = this.options();
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
      this.activate();
    }
  }
}
