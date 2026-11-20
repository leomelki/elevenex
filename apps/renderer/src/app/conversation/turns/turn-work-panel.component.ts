import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, effect, input, linkedSignal, output, signal, untracked, viewChild,
} from '@angular/core';
import { AutoHeightDirective, ButtonComponent, FoldComponent, IconComponent, SkeletonComponent, StatusGlyphComponent } from '../../ui';
import type { DeferredTurnWork, TurnWorkAction } from '../conversation.models';

const PLACEHOLDER_DELAY_MS = 150;
type WorkError = NonNullable<DeferredTurnWork['error']>;
type PanelView =
  | { readonly mode: 'loading' }
  | { readonly mode: 'error'; readonly error: WorkError }
  | {
      readonly mode: 'pager';
      readonly window: NonNullable<DeferredTurnWork['window']>;
      readonly busy: boolean;
      readonly canNavigate: boolean;
      readonly error?: WorkError;
    };

@Component({
  selector: 'ex-turn-work-panel',
  imports: [NgTemplateOutlet, AutoHeightDirective, ButtonComponent, FoldComponent, IconComponent, SkeletonComponent, StatusGlyphComponent],
  templateUrl: './turn-work-panel.component.html',
  styleUrl: './turn-work-panel.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TurnWorkPanelComponent {
  readonly work = input.required<DeferredTurnWork>();
  readonly expanded = input(false);
  readonly requested = output<TurnWorkAction>();
  readonly layoutChanging = output<void>();
  private readonly fold = viewChild<FoldComponent, ElementRef<HTMLElement>>('fold', { read: ElementRef });
  private readonly delayed = signal(false);
  private readonly errorMessages: Readonly<Record<WorkError, string>> = {
    changed: 'This activity has changed.',
    unavailable: 'Waiting for the connection…',
    failed: 'Couldn’t load activity.',
  };
  protected readonly view = computed<PanelView | null>(() => {
    const { busy, error, window } = this.work();
    if (window && (window.previous || window.next || busy || error)) {
      return { mode: 'pager', window, busy, error, canNavigate: !busy && error !== 'changed' };
    }
    if (error) return { mode: 'error', error };
    if (busy && this.delayed()) return { mode: 'loading' };
    return null;
  });
  // Retain the painted surface through Fold's exit. It is inert as soon as
  // the new page arrives or the reader closes Worked.
  protected readonly painted = linkedSignal<PanelView | null, PanelView | null>({
    source: this.view,
    computation: (view, previous) => view ?? previous?.value ?? null,
  });

  constructor() {
    effect(cleanup => {
      const waiting = this.expanded() && this.work().busy && !this.work().window;
      if (!waiting) {
        this.delayed.set(false);
        return;
      }
      const timer = setTimeout(() => this.delayed.set(true), PLACEHOLDER_DELAY_MS);
      cleanup(() => clearTimeout(timer));
    });
    effect(() => {
      if (this.expanded() && this.view()) untracked(() => this.layoutChanging.emit());
    });
    afterRenderEffect(cleanup => {
      if ((this.expanded() && this.view()) || !this.painted()) return;
      const animations = this.fold()?.nativeElement.getAnimations?.() ?? [];
      if (!animations.length) {
        this.painted.set(null);
        return;
      }
      let current = true;
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (current) this.painted.set(null);
      });
      cleanup(() => { current = false; });
    });
  }

  protected request(action: TurnWorkAction): void {
    if (this.expanded() && !this.work().busy) this.requested.emit(action);
  }

  protected errorMessage(error: WorkError): string {
    return this.errorMessages[error];
  }
}
