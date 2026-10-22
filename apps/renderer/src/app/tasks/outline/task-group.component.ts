import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnChanges,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  FlipDirective,
  FoldComponent,
  IconButtonComponent,
  IconComponent,
  StatusGlyphComponent,
} from '../../ui';
import {
  matchesSessionFilter,
  type SessionStatus,
  type TaskOutline,
  type TaskStage,
} from '../task.models';
import { ProjectMarkComponent } from '../projects/project-mark.component';
import { LinkChipComponent } from '../lifecycle/link-chip.component';
import { SessionRowComponent } from './session-row.component';
@Component({
  selector: 'ex-task-group',
  imports: [
    FlipDirective,
    FoldComponent,
    IconButtonComponent,
    IconComponent,
    StatusGlyphComponent,
    ProjectMarkComponent,
    LinkChipComponent,
    SessionRowComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './task-group.component.html',
  styleUrl: './task-group.component.css',
})
export class TaskGroupComponent implements OnChanges {
  readonly task = input.required<TaskOutline>();
  readonly selected = input<string | null>(null);
  readonly filter = input<SessionStatus | null>(null);
  readonly showProject = input(true);
  readonly showLink = input(false);
  readonly allowAdd = input(true);
  readonly selectSession = output<string>();
  readonly addSession = output<string>();
  protected readonly collapsedValue = signal<boolean | null>(null);
  protected readonly finishedValue = signal(false);
  protected readonly collapsed = computed(() =>
    this.filter()
      ? false
      : (this.collapsedValue() ??
        this.task().collapsed ??
        ['waiting', 'planned', 'closed'].includes(
          this.task().stage ?? 'active',
        )),
  );
  protected readonly working = computed(() =>
    this.task().sessions.filter(
      (session) =>
        (session.status !== 'done' || this.filter() === 'done') &&
        matchesSessionFilter(session.status, this.filter()),
    ),
  );
  protected readonly finished = computed(() =>
    this.filter()
      ? []
      : this.task().sessions.filter((session) => session.status === 'done'),
  );
  protected readonly finishedOpen = computed(
    () =>
      this.finishedValue() ||
      this.finished().some((session) => session.id === this.selected()),
  );
  protected readonly attention = computed(
    () =>
      this.task().sessions.filter(
        (session) =>
          session.status === 'attention' || session.status === 'failed',
      ).length,
  );
  protected readonly running = computed(
    () =>
      this.task().sessions.filter((session) => session.status === 'running')
        .length,
  );
  protected readonly leadLink = computed(
    () =>
      this.task().links?.find((link) => link.kind === 'pr') ??
      this.task().links?.[0],
  );
  private previousStage: TaskStage | undefined;
  private foldTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.foldTimer));
  }
  ngOnChanges(): void {
    const stage = this.task().stage ?? 'active';
    if (this.previousStage && this.previousStage !== stage) {
      clearTimeout(this.foldTimer);
      this.collapsedValue.set(false);
      if (stage === 'waiting' || stage === 'planned') {
        const duration = matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 0
          : parseFloat(
              getComputedStyle(this.root).getPropertyValue('--dur-glide'),
            ) || 0;
        if (duration)
          this.foldTimer = setTimeout(
            () => this.collapsedValue.set(true),
            duration,
          );
        else this.collapsedValue.set(true);
      }
    }
    this.previousStage = stage;
  }
  protected toggle(): void {
    this.collapsedValue.set(!this.collapsed());
  }
}
