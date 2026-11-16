import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import { CdkMenuTrigger } from '@angular/cdk/menu';
import { DropdownItemComponent, DropdownMenuComponent, FoldComponent, IconComponent, TickerComponent, TooltipDirective } from '../../ui';
import type { SessionMoveIntent, TaskSession } from '../task.models';
import { SessionNestingDragDirective } from './session-nesting-drag.directive';
import { SessionRowComponent } from './session-row.component';

/** A bounded two-level group; the owner supplies children and performs all moves. */
@Component({
  selector: 'ex-session-branch',
  imports: [CdkMenuTrigger, DropdownItemComponent, DropdownMenuComponent, FoldComponent, IconComponent, TickerComponent, TooltipDirective, SessionRowComponent],
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
  readonly moveRequested = output<SessionMoveIntent>();
  readonly childrenRequested = output<{ readonly sessionId: string; readonly earlier?: boolean }>();
  protected readonly drag = inject(SessionNestingDragDirective, { optional: true });
  protected readonly children = computed(() => this.sessions().filter(row => row.parentId === this.session().id));
  protected readonly containsSelection = computed(() => this.children().some(row => row.id === this.selected()));
  protected readonly expanded = linkedSignal<{ id: string; selected: boolean }, boolean>({ source: () => ({ id: this.session().id, selected: this.containsSelection() || this.drag?.droppedParent() === this.session().id }), computation: (value, previous) => value.selected || (previous?.source.id === value.id && previous.value) || false });
  protected readonly targets = computed(() => this.sessions().filter(row => !row.parentId && !row.local && row.id !== this.session().id).slice(0, 20));
  protected readonly dropActive = computed(() => this.drag?.target()?.id === this.session().id);
  protected readonly childCount = computed(() => this.session().childCount ?? this.children().length);
  protected toggle(): void {
    this.expanded.update(value => !value);
    if (this.expanded()) this.childrenRequested.emit({ sessionId: this.session().id });
  }
}
