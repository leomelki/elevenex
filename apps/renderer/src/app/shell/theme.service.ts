import { DOCUMENT } from "@angular/common";
import { DestroyRef, Injectable, inject, signal } from "@angular/core";
import type { Theme } from "@elevenex/shared";

/** One subscription owner per renderer, cleaned up with its application injector. */
@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly current = signal<Theme>("light");
  readonly theme = this.current.asReadonly();

  constructor() {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = (theme: Theme) => {
      this.current.set(theme);
      this.document.documentElement.dataset["theme"] = theme;
    };
    const changed = () => apply(media.matches ? "dark" : "light");
    changed();
    media.addEventListener("change", changed);
    const unsubscribe = window.elevenex?.onThemeChanged(apply);
    inject(DestroyRef).onDestroy(() => {
      media.removeEventListener("change", changed);
      unsubscribe?.();
    });
  }
}
