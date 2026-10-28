import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, Injector, input, linkedSignal, model, output, signal, viewChildren } from '@angular/core';
import { EaseSwapComponent, FoldComponent, IconComponent, TickerComponent } from '../../ui';
import { ListPresence } from '../../ui/motion/list-presence';
import type { TaskSession, TaskSessionDisclosure } from '../task.models';
import { SessionRowComponent } from './session-row.component';
import { SessionBatchComponent } from './session-batch.component';
import { sessionWindow } from './session-window';

interface Batch {
  readonly key: string;
  readonly sessions: readonly TaskSession[];
  readonly open: boolean;
  readonly initial: boolean;
}
interface BatchSource {
  readonly taskId: string;
  readonly window: ReturnType<typeof sessionWindow>;
}

/** Owns disclosure and placement, independently from the task/sub-task outline. */
@Component({
  selector: 'ex-working-sessions',
  imports: [EaseSwapComponent, FoldComponent, IconComponent, TickerComponent, SessionRowComponent, SessionBatchComponent],
  templateUrl: './working-sessions.component.html',
  styleUrl: './working-sessions.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkingSessionsComponent {
  readonly taskId = input.required<string>();
  readonly sessions = input.required<readonly TaskSession[]>();
  readonly selected = input<string | null>(null);
  readonly filtered = input(false);
  readonly cap = input(5);
  readonly capStep = input(5);
  readonly allowArchive = input(false);
  readonly disclosure = model<TaskSessionDisclosure | null>(null);
  readonly activated = output<string>();
  readonly archiveRequested = output<TaskSession>();
  protected readonly window = computed(() => sessionWindow(this.sessions(), this.cap(), this.selected(), this.filtered(), this.disclosure()?.taskId === this.taskId() ? this.disclosure() : null));
  protected readonly hidden = computed(() => this.window().hidden.size);
  protected readonly step = computed(() => Number.isFinite(this.capStep()) ? Math.max(1, Math.floor(this.capStep())) : 5);
  protected readonly next = computed(() => Math.min(this.step(), this.hidden()));
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private readonly batchViews = viewChildren(SessionBatchComponent);
  protected readonly closingDistance = signal(0);
  protected readonly presence = new ListPresence(() => this.window().shown, session => session.id, this.host, inject(DestroyRef));
  protected readonly batches = linkedSignal<BatchSource, readonly Batch[]>({
    source: () => ({ taskId: this.taskId(), window: this.window() }),
    computation: (source, previous) => {
      const initial = !previous || previous.source.taskId !== source.taskId;
      const current = source.window.batches.map(batch => ({ ...batch, open: true, initial }));
      if (initial) return current;
      const keys = new Set(current.map(batch => batch.key));
      const shown = new Set(source.window.shown.map(session => session.id));
      return [...current, ...previous.value.filter(batch => !keys.has(batch.key)).map(batch => ({ ...batch, open: false, sessions: batch.sessions.filter(session => !shown.has(session.id)) }))];
    },
  });
  protected readonly orderedBatches = computed(() => [...this.batches()].reverse());
  protected settled(key: string): void { this.batches.update(batches => batches.filter(batch => batch.key !== key || batch.open)); }
  protected more(): void {
    const window = this.window();
    const hidden = [...window.hidden];
    const ids = hidden.splice(-this.step());
    this.disclosure.set({ taskId: this.taskId(), cap: this.cap(), hiddenIds: hidden,
      batches: [...window.batches.map(batch => batch.sessions.map(session => session.id)), ids] });
  }
  protected fewer(event: Event): void {
    const focus = event.currentTarget === this.host.ownerDocument.activeElement;
    this.closingDistance.set(this.batchViews().reduce((height, batch) => height + batch.paintedHeight(), 0));
    this.disclosure.set(null);
    if (focus) afterNextRender(() => this.host.querySelector<HTMLButtonElement>('.earlier-more')?.focus({ preventScroll: true }), { injector: this.injector });
  }
}
