import {
  DestroyRef,
  Directive,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
} from "@angular/core";

interface Position {
  readonly x: number;
  readonly y: number;
}
/** Mark participating rows data-flip="stable-id" and pass a changed collection. */
@Directive({ selector: "[exFlip]" })
export class FlipDirective {
  readonly exFlip = input.required<unknown>();
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private previous = new Map<string, Position>();
  private readonly animations = new Map<string, Animation>();

  constructor() {
    afterRenderEffect({
      earlyRead: () => {
        this.exFlip();
        return Array.from(
          this.root.querySelectorAll<HTMLElement>("[data-flip]"),
        ).map((element) => {
          const key = element.dataset["flip"] ?? "";
          const previous = this.previous.get(key);
          const matrix = this.animations.has(key)
            ? new DOMMatrixReadOnly(getComputedStyle(element).transform)
            : null;
          return {
            element,
            key,
            box: { x: element.offsetLeft, y: element.offsetTop },
            // An interrupted move starts from its current painted position.
            visual: previous
              ? {
                  x: previous.x + (matrix?.m41 ?? 0),
                  y: previous.y + (matrix?.m42 ?? 0),
                }
              : undefined,
          };
        });
      },
      write: (rows) => {
        const next = new Map<string, Position>();
        const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const style = getComputedStyle(this.root);
        for (const { element, key, box, visual } of rows()) {
          next.set(key, box);
          const before = this.previous.get(key);
          if (
            !before ||
            reduce ||
            !element.animate ||
            (before.x === box.x && before.y === box.y)
          )
            continue;
          this.animations.get(key)?.cancel();
          const from = visual ?? before;
          const animation = element.animate(
            [
              {
                transform: `translate(${from.x - box.x}px, ${from.y - box.y}px)`,
              },
              { transform: "none" },
            ],
            {
              duration: parseFloat(style.getPropertyValue("--dur-glide")),
              easing: style.getPropertyValue("--ease-glide").trim(),
            },
          );
          this.animations.set(key, animation);
          animation.onfinish = animation.oncancel = () => {
            if (this.animations.get(key) === animation)
              this.animations.delete(key);
          };
        }
        for (const [key, animation] of this.animations)
          if (reduce || !next.has(key)) animation.cancel();
        this.previous = next;
      },
    });
    inject(DestroyRef).onDestroy(() => {
      for (const animation of this.animations.values()) animation.cancel();
    });
  }
}
