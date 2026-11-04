import { DOCUMENT } from '@angular/common';
import { afterNextRender, DestroyRef, Directive, ElementRef, inject, output } from '@angular/core';

/** Keep the expensive child browsing context out of the shell's width animation.
 * Only its composited surface follows intermediate sizes; upstream lays out once
 * at the end. Ordinary window resizing remains live. No iframe is recreated. */
@Directive({ selector: '[exCodeViewport]' })
export class CodeViewportDirective {
  readonly viewportWidth = output<number>();
  private readonly frame = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly document = inject(DOCUMENT);

  constructor() {
    let dispose: (() => void) | undefined;
    afterNextRender(() => { dispose = this.observe(); });
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

    const measure = () => {
      const next = viewport.clientWidth;
      if (frozenWidth) {
        if (next > 0) this.frame.style.transform = `scaleX(${next / frozenWidth})`;
      } else if (next > 0) {
        width = next;
        this.viewportWidth.emit(width);
      }
    };
    const release = () => {
      frozenWidth = 0;
      this.frame.style.removeProperty('width');
      this.frame.style.removeProperty('transform');
      this.frame.classList.remove('resizing');
      measure();
    };
    const changed = (event: Event) => {
      const ancestor = event.target;
      // Listen on the document because transition events do not travel down to
      // projected content. Unrelated widths, opacity and nested effects cannot
      // hold the editor's viewport. No shell-private selectors are needed.
      if (!('propertyName' in event) || event.propertyName !== 'width' || !(ancestor instanceof HTMLElement) || ancestor === this.frame || !ancestor.contains(viewport)) return;
      if (event.type === 'transitionrun') {
        if (reduced.matches || viewport.clientWidth <= 0) return;
        transitions.add(ancestor);
        if (!frozenWidth && width > 0) {
          frozenWidth = width;
          this.frame.style.width = `${width}px`;
          this.frame.classList.add('resizing');
          measure();
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
      for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) this.document.removeEventListener(type, changed, true);
      reduced.removeEventListener('change', motionChanged);
      this.frame.style.removeProperty('width');
      this.frame.style.removeProperty('transform');
      this.frame.classList.remove('resizing');
    };
  }
}
