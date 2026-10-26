import { CdkTrapFocus } from '@angular/cdk/a11y';
import { NgTemplateOutlet } from '@angular/common';
import {
  afterRenderEffect, ChangeDetectionStrategy, Component, computed, DestroyRef,
  ElementRef, inject, input, output, Renderer2, signal, TemplateRef, viewChild,
} from '@angular/core';

/** One persistent surface; its owner supplies machine news and event expiry. */
@Component({
  selector: 'ex-title-island',
  imports: [CdkTrapFocus, NgTemplateOutlet],
  templateUrl: './title-island.component.html',
  styleUrl: './title-island.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'dismiss($event)' },
})
export class TitleIslandComponent {
  readonly contentKey = input('');
  readonly tone = input<'rest' | 'info' | 'warn' | 'ok'>('rest');
  readonly tall = input(false);
  readonly open = input(false);
  readonly label = input('Machine details');
  readonly controls = input<string>();
  readonly progress = input<number>();
  readonly panel = input<TemplateRef<unknown>>();
  readonly pressed = output<void>();
  readonly dismissed = output<void>();
  protected readonly content = viewChild<ElementRef<HTMLElement>>('content');
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  protected readonly width = signal<number | undefined>(undefined);
  protected readonly height = signal<number | undefined>(undefined);
  protected readonly expanded = computed(() => this.open() && !!this.panel());
  protected readonly progressValue = computed(() => {
    const value = this.progress() ?? 0;
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  });
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private observer?: ResizeObserver;
  private lastState?: string;
  private animation?: Animation;
  private wasExpanded = false;
  private restoreFocus = true;

  constructor() {
    const renderer = inject(Renderer2);
    const unlisten = renderer.listen('document', 'pointerdown', (event: PointerEvent) => {
      if (this.expanded() && event.target instanceof Node && !this.element.contains(event.target)) {
        // An outside click owns its focus; do not pull it back to the island.
        this.restoreFocus = false;
        this.dismissed.emit();
      }
    });
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const stopMotion = () => this.animation?.cancel();
    motion.addEventListener('change', stopMotion);
    inject(DestroyRef).onDestroy(() => {
      this.observer?.disconnect();
      this.animation?.cancel();
      motion.removeEventListener('change', stopMotion);
      unlisten();
    });
    afterRenderEffect(() => {
      const content = this.content()?.nativeElement;
      const state = JSON.stringify([this.contentKey(), this.open(), this.tall()]);
      const expanded = this.expanded();
      // The browser blurs a trigger when it becomes hidden, before CDK captures
      // the dialog's return target. Restore this persistent trigger explicitly.
      if (this.wasExpanded && !expanded) {
        if (this.restoreFocus) this.trigger()?.nativeElement.focus({ preventScroll: true });
        this.restoreFocus = true;
      }
      this.wasExpanded = expanded;
      if (!content) return;
      if (!this.observer && typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(() => this.measure(content));
        this.observer.observe(content);
      }
      this.measure(content);
      if (this.lastState !== undefined && this.lastState !== state) {
        this.animation?.cancel();
        if (!motion.matches && content.animate) {
          const style = getComputedStyle(content);
          this.animation = content.animate([
            { opacity: 0, filter: 'blur(4px)', transform: 'translateX(-50%) scale(.94)' },
            { opacity: 1, filter: 'blur(0)', transform: 'translateX(-50%) scale(1)' },
          ], {
            duration: parseFloat(style.getPropertyValue('--dur-slow')),
            // The design's 60ms beat lets the shell lead its incoming content.
            delay: 60,
            easing: style.getPropertyValue('--ease-out').trim(),
            fill: 'backwards',
          });
        }
      }
      this.lastState = state;
    });
  }

  protected dismiss(event: Event): void {
    if (!this.expanded()) return;
    event.stopPropagation();
    this.restoreFocus = true;
    this.dismissed.emit();
  }

  private measure(content: HTMLElement): void {
    // Measure intrinsic layout, never the transformed/animated rectangle.
    this.width.set(content.offsetWidth);
    this.height.set(content.offsetHeight);
  }
}
