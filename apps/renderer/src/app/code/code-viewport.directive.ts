import { DOCUMENT } from '@angular/common';
import { afterNextRender, afterRenderEffect, DestroyRef, Directive, ElementRef, inject, input, output, signal } from '@angular/core';

/** Keep text at its natural scale while the shell glides. Cover the retained
 * viewport, resize once underneath, then reveal after a child-layout acknowledgement.
 * Ordinary window resizing remains live. No iframe is recreated. */
@Directive({ selector: '[exCodeViewport]' })
export class CodeViewportDirective {
  readonly viewportWidth = output<number>();
  readonly layoutRequested = output<void>();
  readonly layoutReady = input(true);
  private readonly settlement = signal(0);
  private revealWhenReady?: () => void;
  private readonly frame = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly document = inject(DOCUMENT);

  constructor() {
    let dispose: (() => void) | undefined;
    afterNextRender(() => { dispose = this.observe(); });
    afterRenderEffect(() => {
      this.settlement();
      if (this.layoutReady()) this.revealWhenReady?.();
    });
    inject(DestroyRef).onDestroy(() => dispose?.());
  }

  private observe(): () => void {
    const viewport = this.frame.parentElement;
    const window = this.document.defaultView;
    if (!viewport || !window) return () => undefined;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const transitions = new Set<HTMLElement>();
    let width = viewport.clientWidth;
    let frozenWidth = 0;
    let pending = 0;
    let reveal = 0;
    let awaitingLayout = false;

    const cancelReveal = () => {
      window.cancelAnimationFrame(reveal);
      reveal = 0;
    };

    const measure = () => {
      const next = viewport.clientWidth;
      if (!frozenWidth && next > 0) {
        width = next;
        this.viewportWidth.emit(width);
      }
    };
    const release = () => {
      frozenWidth = 0;
      this.frame.style.removeProperty('width');
      this.frame.classList.remove('resizing');
      measure();
      cancelReveal();
      awaitingLayout = true;
      this.layoutRequested.emit();
      this.settlement.update(value => value + 1);
    };
    this.revealWhenReady = () => {
      if (!awaitingLayout || frozenWidth || reveal) return;
      // Main acknowledges the expected child viewport, upstream compact-mode
      // commands and quiet workbench geometry before the reveal can begin.
      reveal = window.requestAnimationFrame(() => {
        reveal = 0;
        awaitingLayout = false;
        this.frame.classList.remove('reflowing');
      });
    };
    const changed = (event: Event) => {
      const ancestor = event.target;
      // Listen on the document because transition events do not travel down to
      // projected content. Unrelated widths, opacity and nested effects cannot
      // hold the editor's viewport. No shell-private selectors are needed.
      if (!('propertyName' in event) || event.propertyName !== 'width' || !(ancestor instanceof HTMLElement) || ancestor === this.frame || !ancestor.contains(viewport)) return;
      if (event.type === 'transitionrun') {
        // Use the last settled measurement: reading layout here would flush
        // the first animated width into the child before we can freeze it.
        if (reduced.matches || width <= 0) return;
        transitions.add(ancestor);
        if (!frozenWidth && width > 0) {
          cancelReveal();
          awaitingLayout = false;
          frozenWidth = width;
          this.frame.style.width = `${width}px`;
          this.frame.classList.add('resizing', 'reflowing');
        }
      } else {
        transitions.delete(ancestor);
        window.cancelAnimationFrame(pending);
        // A reversal cancels one transition and starts its replacement in the
        // same rendering update. Keep the original viewport through that pair.
        pending = window.requestAnimationFrame(() => {
          pending = 0;
          if (!transitions.size) release();
        });
      }
    };
    const motionChanged = () => {
      if (!reduced.matches) return;
      transitions.clear();
      window.cancelAnimationFrame(pending);
      pending = 0;
      release();
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(viewport);
    measure();
    for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) this.document.addEventListener(type, changed, true);
    reduced.addEventListener('change', motionChanged);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(pending);
      cancelReveal();
      this.revealWhenReady = undefined;
      for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) this.document.removeEventListener(type, changed, true);
      reduced.removeEventListener('change', motionChanged);
      this.frame.style.removeProperty('width');
      this.frame.classList.remove('resizing', 'reflowing');
    };
  }
}
