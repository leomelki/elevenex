import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';

@Component({
  selector: 'ex-title-island',
  templateUrl: './title-island.component.html',
  styleUrl: './title-island.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TitleIslandComponent {
  readonly contentKey = input('');
  readonly tone = input<'rest' | 'info' | 'warn' | 'ok'>('rest');
  readonly tall = input(false);
  readonly open = input(false);
  readonly label = input('Machine details');
  readonly controls = input<string>();
  readonly progress = input<number>();
  readonly pressed = output<void>();
  protected readonly content = viewChild<ElementRef<HTMLElement>>('content');
  protected readonly width = signal<number | undefined>(undefined);
  protected readonly height = signal<number | undefined>(undefined);
  protected readonly progressValue = computed(() => Math.min(1, Math.max(0, this.progress() ?? 0)));
  private observer?: ResizeObserver;
  private observed?: HTMLElement;
  private lastKey?: string;
  private animation?: Animation;

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.observer?.disconnect(); this.animation?.cancel(); });
    afterRenderEffect(() => {
      const content = this.content()?.nativeElement;
      const key = this.contentKey();
      if (!content) return;
      if (content !== this.observed) {
        this.observer?.disconnect();
        this.observed = content;
        this.observer = new ResizeObserver(() => {
          this.width.set(content.offsetWidth);
          this.height.set(content.offsetHeight);
        });
        this.observer.observe(content);
      }
      this.width.set(content.offsetWidth);
      this.height.set(content.offsetHeight);
      if (this.lastKey !== undefined && this.lastKey !== key && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        this.animation?.cancel();
        this.animation = content.animate([{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 280, easing: 'ease-out' });
      }
      this.lastKey = key;
    });
  }
}
