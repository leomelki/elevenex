import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { ButtonComponent } from "../button/button.component";
import { IconButtonComponent } from "../button/icon-button.component";
import { StatusGlyphComponent } from "../status/status-glyph.component";
import { Status } from "../status/status.models";

@Component({
  selector: "ex-toast",
  imports: [ButtonComponent, IconButtonComponent, StatusGlyphComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: "status",
    "(mouseenter)": "setHovered(true)",
    "(mouseleave)": "setHovered(false)",
    "(focusin)": "setFocused(true)",
    "(focusout)": "onFocusOut($event)",
  },
  templateUrl: "./toast.component.html",
  styleUrl: "./toast.component.css",
})
export class ToastComponent {
  readonly title = input.required<string>();
  readonly detail = input("");
  readonly action = input("");
  readonly tone = input<"normal" | "danger">("normal");
  readonly glyph = input<Status>("done");
  readonly duration = input(5000);
  readonly actionSelected = output<void>();
  readonly dismissed = output<void>();
  protected readonly paused = signal(false);
  private remaining = 0;
  private started = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private finished = false;
  private hovered = false;
  private focused = false;

  constructor() {
    afterNextRender(() => {
      this.remaining = this.duration();
      this.resume();
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected pause(): void {
    if (this.timer) {
      this.remaining = Math.max(
        0,
        this.remaining - (performance.now() - this.started),
      );
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.paused.set(true);
  }
  protected resume(): void {
    if (this.hovered || this.focused) return;
    this.paused.set(false);
    if (this.finished || this.duration() === 0 || this.timer) return;
    this.started = performance.now();
    this.timer = setTimeout(() => this.dismiss(), this.remaining);
  }
  protected setHovered(value: boolean): void {
    this.hovered = value;
    if (value) this.pause();
    else this.resume();
  }
  protected setFocused(value: boolean): void {
    this.focused = value;
    if (value) this.pause();
    else this.resume();
  }
  protected onFocusOut(event: FocusEvent): void {
    if (
      !(event.currentTarget instanceof HTMLElement) ||
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    )
      this.setFocused(false);
  }
  protected dismiss(): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    this.dismissed.emit();
  }
}
