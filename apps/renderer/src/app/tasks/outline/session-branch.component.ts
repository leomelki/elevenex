import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, linkedSignal, output, untracked } from '@angular/core';
import { CdkMenuTrigger } from '@angular/cdk/menu';
import { DropdownItemComponent, DropdownMenuComponent, EaseSwapComponent, FoldComponent, IconComponent, StatusGlyphComponent, TickerComponent, TooltipDirective } from '../../ui';
import { ListPresence } from '../../ui/motion/list-presence';
import type { SessionMoveIntent, TaskSession } from '../task.models';
import { SessionNestingDragDirective } from './session-nesting-drag.directive';
import { SessionRowComponent } from './session-row.component';

/** A bounded two-level group; the owner supplies children and performs all moves. */
const noChildren: readonly TaskSession[] = [];
const compactChildLimit = 2;
@Component({
  selector: 'ex-session-branch',
  imports: [CdkMenuTrigger, DropdownItemComponent, DropdownMenuComponent, EaseSwapComponent, FoldComponent, IconComponent,
    StatusGlyphComponent, TickerComponent, TooltipDirective, SessionRowComponent],
  templateUrl: './session-branch.component.html',
  styleUrl: './session-branch.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionBranchComponent {
  readonly session = input.required<TaskSession>();
  readonly sessions = input<readonly TaskSession[]>([]);
  readonly selected = input<string | null>(null);
  readonly muted = input(false);
  readonly allowArchive = input(false);
  readonly allowNesting = input(false);
  readonly activated = output<string>();
  readonly archiveRequested = output<TaskSession>();
  readonly deleteRequested = output<TaskSession>();
  readonly moveRequested = output<SessionMoveIntent>();
  readonly childrenRequested = output<{ readonly sessionId: string; readonly earlier?: boolean }>();
  protected readonly drag = inject(SessionNestingDragDirective, { optional: true });
  protected readonly children = computed(() => this.session().parentId ? noChildren :
    this.sessions().filter(row => row.parentId === this.session().id));
  protected readonly containsSelection = computed(() => this.children().some(row => row.id === this.selected()));
  protected readonly expanded = linkedSignal<{ id: string; selected: boolean }, boolean>({ source: () => ({ id: this.session().id, selected: this.containsSelection() || this.drag?.droppedParent() === this.session().id }), computation: (value, previous) => value.selected || (previous?.source.id === value.id && previous.value) || false });
  protected readonly targets = computed(() => this.sessions().filter(row => !row.parentId && !row.local && row.id !== this.session().id).slice(0, 20));
  protected readonly dropActive = computed(() => this.drag?.target()?.id === this.session().id);
  /** The count includes a session that is docked here or landing here. */
  protected readonly pending = computed(() => this.dropActive() || this.drag?.landing()?.parentId === this.session().id);
  protected readonly moving = computed(() => this.drag?.movingId() === this.session().id);
  /** Held over the task header, the moved row previews task level in place. */
  protected readonly outdentPreview = computed(() => this.moving() && !!this.drag?.toTaskLevel());
  /** While aiming, groups that cannot accept the dragged session recede. */
  protected readonly unavailable = computed(() => {
    const drag = this.drag, session = this.session();
    if (!drag?.source()) return false;
    const root = session.parentId ? this.sessions().find(row => row.id === session.parentId) : session;
    return !!root && !drag.accepts(root);
  });
  protected readonly childCount = computed(() => this.session().childCount ?? this.children().length);
  protected readonly summary = computed(() => !this.expanded() && !this.pending() ? this.session().childSummary : undefined);
  protected readonly rollupLabel = computed(() => {
    const summary = this.summary(), count = this.childCount();
    if (!summary) return count + (count === 1 ? ' child session' : ' child sessions');
    const state = { attention: 'need you', failed: 'failed', running: 'running', done: 'finished' }[summary.status];
    return summary.count + ' of ' + count + ' ' + (summary.status === 'attention' && summary.count === 1 ? 'needs you' : state);
  });
  protected readonly showAllChildren = linkedSignal({
    source: () => ({ id: this.session().id, expanded: this.expanded(), droppedParent: this.drag?.droppedParent() }),
    computation: ({ id, expanded, droppedParent }, previous): boolean =>
      expanded && ((droppedParent === id && previous?.source.droppedParent !== id) ||
        (previous?.source.id === id && previous.value)),
  });
  protected readonly hiddenChildCount = computed(() => Math.max(0, this.children().length - compactChildLimit));
  private readonly visibleChildren = computed(() => {
    const children = this.children();
    if (this.showAllChildren() || !this.hiddenChildCount()) return children;
    const compact = children.slice(-compactChildLimit);
    const selected = children.find(row => row.id === this.selected());
    if (selected && !compact.includes(selected)) compact[0] = selected;
    return compact;
  });
  protected readonly presence = new ListPresence(this.visibleChildren, row => row.renderId ?? row.id,
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement, inject(DestroyRef));

  constructor() {
    let previous: { id: string; count: number } | undefined;
    effect(() => {
      const id = this.session().id, count = this.childCount(), selection = this.selected();
      if (id === selection && previous?.id === id && count > previous.count && !untracked(this.expanded)) {
        this.expanded.set(true);
        this.childrenRequested.emit({ sessionId: id });
      }
      previous = { id, count };
    });
  }
  protected toggle(): void {
    this.expanded.update(value => !value);
    if (this.expanded()) this.childrenRequested.emit({ sessionId: this.session().id });
  }
}
