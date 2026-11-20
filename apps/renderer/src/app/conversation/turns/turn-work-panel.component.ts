import {
  ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, input, linkedSignal, output, viewChild,
} from '@angular/core';
import { ButtonComponent, FoldComponent, IconComponent } from '../../ui';
import type { DeferredTurnWork, TurnWorkAction } from '../conversation.models';

type WorkError = NonNullable<DeferredTurnWork['error']>;

@Component({
  selector: 'ex-turn-work-panel',
  imports: [ButtonComponent, FoldComponent, IconComponent],
  templateUrl: './turn-work-panel.component.html',
  styleUrl: './turn-work-panel.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TurnWorkPanelComponent {
  readonly error = input<WorkError>();
  readonly expanded = input(false);
  readonly requested = output<TurnWorkAction>();
  private readonly fold = viewChild<FoldComponent, ElementRef<HTMLElement>>('fold', { read: ElementRef });
  protected readonly visible = computed(() => this.expanded() && !!this.error());
  protected readonly painted = linkedSignal<WorkError | undefined, WorkError | undefined>({
    source: () => this.expanded() ? this.error() : undefined,
    computation: (current, previous) => current ?? previous?.value,
  });

  constructor() {
    afterRenderEffect(cleanup => {
      if (this.visible() || !this.painted()) return;
      const animations = this.fold()?.nativeElement.getAnimations?.() ?? [];
      if (!animations.length) {
        this.painted.set(undefined);
        return;
      }
      let closing = true;
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (closing) this.painted.set(undefined);
      });
      cleanup(() => { closing = false; });
    });
  }

  protected retry(): void {
    if (this.visible()) this.requested.emit(this.error() === 'changed' ? 'refresh' : 'retry');
  }
}
