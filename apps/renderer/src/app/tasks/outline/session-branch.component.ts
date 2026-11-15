import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { CdkMenuTrigger } from '@angular/cdk/menu';
import { DropdownItemComponent, DropdownMenuComponent, FoldComponent, IconComponent, TooltipDirective } from '../../ui';
import type { SessionMoveIntent, TaskSession } from '../task.models';
import { SessionRowComponent } from './session-row.component';

/** A bounded two-level group; the owner supplies children and performs all moves. */
@Component({
  selector: 'ex-session-branch',
  imports: [CdkMenuTrigger, DropdownItemComponent, DropdownMenuComponent, FoldComponent, IconComponent, TooltipDirective, SessionRowComponent],
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
  readonly dragSource = input<TaskSession | null>(null);
  readonly activated = output<string>();
  readonly archiveRequested = output<TaskSession>();
  readonly moveRequested = output<SessionMoveIntent>();
  readonly childrenRequested = output<{ readonly sessionId: string; readonly earlier?: boolean }>();
  protected readonly children = computed(() => this.sessions().filter(row => row.parentId === this.session().id));
  protected readonly containsSelection = computed(() => this.children().some(row => row.id === this.selected()));
  protected readonly expanded = linkedSignal<{ id: string; selected: boolean }, boolean>({ source: () => ({ id: this.session().id, selected: this.containsSelection() }), computation: (value, previous) => value.selected || (previous?.source.id === value.id && previous.value) || false });
  protected readonly targets = computed(() => this.sessions().filter(row => !row.parentId && !row.local && row.id !== this.session().id).slice(0, 20));
  protected readonly dropActive = signal(false);
  protected readonly canDrop = computed(() => {
    const source = this.dragSource(), target = this.session();
    return this.allowNesting() && !!source && !source.local && !source.childCount && !target.local && !target.parentId && source.id !== target.id && source.parentId !== target.id;
  });
  protected toggle(): void {
    this.expanded.update(value => !value);
    if (this.expanded()) this.childrenRequested.emit({ sessionId: this.session().id });
  }
  protected dragOver(event: DragEvent): void {
    if (!this.canDrop()) return;
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropActive.set(true);
  }
  protected leave(event: DragEvent): void {
    if (!(event.currentTarget instanceof HTMLElement) || !(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) this.dropActive.set(false);
  }
  protected drop(event: DragEvent): void {
    this.dropActive.set(false);
    if (!this.canDrop()) return;
    event.preventDefault(); event.stopPropagation();
    this.expanded.set(true);
    const source = this.dragSource();
    if (source) this.moveRequested.emit({ sessionId: source.id, parentSessionId: this.session().id });
  }
}
