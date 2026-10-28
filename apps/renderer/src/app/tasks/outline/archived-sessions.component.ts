import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, linkedSignal, output } from '@angular/core';
import { ButtonComponent, FoldComponent, IconComponent } from '../../ui';
import { ListPresence } from '../../ui/motion/list-presence';
import type { TaskSession, TaskSessionArchive } from '../task.models';
import { SessionRowComponent } from './session-row.component';

/** Local disclosure only; the owner loads history and performs restores. */
@Component({
  selector: 'ex-archived-sessions',
  imports: [ButtonComponent, FoldComponent, IconComponent, SessionRowComponent],
  templateUrl: './archived-sessions.component.html',
  styleUrl: './archived-sessions.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArchivedSessionsComponent {
  readonly archive = input.required<TaskSessionArchive>();
  readonly selected = input<string | null>(null);
  readonly disabled = input(false);
  readonly requested = output<'latest' | 'earlier'>();
  readonly selectSession = output<string>();
  readonly restoreRequested = output<TaskSession>();
  private readonly selectedArchiveId = computed(() => this.archive().sessions.find(session => session.id === this.selected())?.id ?? null);
  // Reveal a newly selected conversation without overriding later manual folds.
  protected readonly open = linkedSignal<string | null, boolean>({
    source: this.selectedArchiveId,
    computation: (selected, previous) => selected !== null || (previous?.value ?? false),
  });
  protected readonly presence = new ListPresence(
    () => this.archive().sessions,
    session => session.id,
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement,
    inject(DestroyRef),
  );

  protected toggle(): void {
    this.open.update(open => !open);
    if (this.open() && !this.archive().loaded && !this.archive().loading) this.requested.emit('latest');
  }
}
