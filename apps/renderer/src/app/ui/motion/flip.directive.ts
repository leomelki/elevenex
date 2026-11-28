import { afterRenderEffect, DestroyRef, Directive, ElementRef, inject, input, OnChanges } from '@angular/core';

interface Position { readonly x: number; readonly y: number }

/** Each scope owns only its direct participants, even when scopes are nested. */
@Directive({ selector: '[exFlip]', host: { 'data-flip-scope': '' } })
export class FlipDirective implements OnChanges {
  readonly exFlip = input.required<unknown>();
  /** Height-revealed lists already move in normal flow on additions/removals. */
  readonly exFlipReorderOnly = input(false);
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private before = new Map<string, Position>();
  private readonly animations = new Map<string, Animation>();
  private readonly media = matchMedia('(prefers-reduced-motion: reduce)');

  constructor() {
    const cancel = () => {
      if (this.media.matches) for (const animation of this.animations.values()) animation.cancel();
    };
    this.media.addEventListener('change', cancel);
    afterRenderEffect({
      earlyRead: () => {
        this.exFlip();
        const root = this.root.getBoundingClientRect();
        return this.elements().map(element => {
          const key = element.dataset['flip']!;
          const rect = element.getBoundingClientRect();
          const matrix = this.animations.has(key) ? new DOMMatrixReadOnly(getComputedStyle(element).transform) : null;
          return { element, key, box: { x: rect.left - root.left - (matrix?.m41 ?? 0), y: rect.top - root.top - (matrix?.m42 ?? 0) } };
        });
      },
      write: values => {
        const rows = values();
        const keys = new Set(rows.map(row => row.key));
        for (const [key, animation] of this.animations) if (!keys.has(key)) animation.cancel();
        const oldOrder = [...this.before.keys()].filter(key => keys.has(key));
        const newOrder = rows.map(row => row.key).filter(key => this.before.has(key));
        if (this.exFlipReorderOnly() && oldOrder.every((key, i) => key === newOrder[i])) return;
        const style = getComputedStyle(this.root);
        for (const { element, key, box } of rows) {
          const before = this.before.get(key);
          this.animations.get(key)?.cancel();
          if (!before || this.media.matches || !element.animate) continue;
          const x = before.x - box.x, y = before.y - box.y;
          if (Math.abs(x) < .5 && Math.abs(y) < .5) continue;
          const animation = element.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }], {
            duration: parseFloat(style.getPropertyValue('--dur-glide')),
            easing: style.getPropertyValue('--ease-glide').trim(),
          });
          this.animations.set(key, animation);
          animation.onfinish = animation.oncancel = () => {
            if (this.animations.get(key) === animation) this.animations.delete(key);
          };
        }
      },
    });
    inject(DestroyRef).onDestroy(() => {
      this.media.removeEventListener('change', cancel);
      for (const animation of this.animations.values()) animation.cancel();
    });
  }

  ngOnChanges(): void {
    // Input hooks precede keyed child updates. Capture painted coordinates so
    // interrupting/reversing a move starts exactly where the previous one is.
    const root = this.root.getBoundingClientRect();
    this.before = new Map(this.elements().map(element => {
      const rect = element.getBoundingClientRect();
      return [element.dataset['flip']!, { x: rect.left - root.left, y: rect.top - root.top }];
    }));
  }

  private elements(): HTMLElement[] {
    return Array.from(this.root.querySelectorAll<HTMLElement>('[data-flip]'))
      .filter(element => element.closest('[data-flip-scope]') === this.root);
  }
}
