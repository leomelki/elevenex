import { afterRenderEffect, DestroyRef, Directive, ElementRef, inject, input, OnChanges } from '@angular/core';

interface Position { readonly x: number; readonly y: number }

/** The Home grid has its own entrance choreography; it never animates behind a launch. */
@Directive({ selector: '[exMachineGridMotion]' })
export class MachineGridMotionDirective implements OnChanges {
  readonly exMachineGridMotion = input.required<unknown>();
  readonly still = input(false);
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly media = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly animations = new Map<HTMLElement, Animation>();
  private before = new Map<string, Position>();
  private painted = false;

  constructor() {
    const stop = () => { if (this.media.matches) this.cancel(); };
    this.media.addEventListener('change', stop);
    afterRenderEffect(() => {
      this.exMachineGridMotion();
      if (this.still() || this.media.matches) { this.cancel(); this.painted = true; return; }
      const style = getComputedStyle(this.root);
      const rows = this.positions(true);
      for (const [element, animation] of this.animations) if (!this.root.contains(element)) animation.cancel();
      for (const { element, key, position } of rows) {
        const previous = this.before.get(key);
        this.animations.get(element)?.cancel();
        if (!element.animate || !this.painted) continue;
        let frames: Keyframe[], options: KeyframeAnimationOptions;
        if (previous) {
          const x = previous.x - position.x, y = previous.y - position.y;
          if (Math.abs(x) < .5 && Math.abs(y) < .5) continue;
          frames = [{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }];
          options = { duration: parseFloat(style.getPropertyValue('--dur-glide')), easing: style.getPropertyValue('--ease-in-out').trim() };
        } else {
          frames = [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }];
          options = { duration: 320, delay: 60, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'backwards' };
          element.style.zIndex = '1';
        }
        const animation = element.animate(frames, options);
        this.animations.set(element, animation);
        animation.onfinish = animation.oncancel = () => {
          if (this.animations.get(element) === animation) {
            this.animations.delete(element); element.style.zIndex = '';
          }
        };
      }
      this.painted = true;
    });
    inject(DestroyRef).onDestroy(() => { this.cancel(); this.media.removeEventListener('change', stop); });
  }

  ngOnChanges(): void {
    // Snapshot before keyed children reflow, including an interrupted painted transform.
    this.before = new Map(this.positions().map(row => [row.key, row.position]));
  }

  private positions(layout = false): { element: HTMLElement; key: string; position: Position }[] {
    const root = this.root.getBoundingClientRect();
    const scale = this.root.offsetWidth ? root.width / this.root.offsetWidth : 1;
    return Array.from(this.root.querySelectorAll<HTMLElement>('[data-grid-key]')).map(element => {
      const rect = element.getBoundingClientRect();
      const matrix = layout && this.animations.has(element) ? new DOMMatrixReadOnly(getComputedStyle(element).transform) : undefined;
      return { element, key: element.dataset['gridKey']!, position: { x: (rect.left - root.left) / (scale || 1) - (matrix?.m41 ?? 0), y: (rect.top - root.top) / (scale || 1) - (matrix?.m42 ?? 0) } };
    });
  }

  private cancel(): void {
    for (const [element, animation] of this.animations) { animation.cancel(); element.style.zIndex = ''; }
    this.animations.clear();
  }
}
