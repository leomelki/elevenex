import {
  ChangeDetectionStrategy,
  Component,
  input,
  signal,
} from "@angular/core";
/** Mounted content preserves local state; inert prevents focus entering a closed fold. */
@Component({
  selector: "ex-fold",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.unroll]": "motion() === 'unroll'",
    "[style.--fold-enter-delay]": "enterDelay() + 'ms'",
    "[style.--fold-exit-delay]": "exitDelay() + 'ms'",
    "[class.open]": "open()",
    "[class.settled]": "settled()",
    "[attr.inert]": 'open() ? null : ""',
    "[attr.aria-hidden]": "!open()",
    "(transitionrun)": "transition($event, false)",
    "(transitionend)": "transition($event, true)",
    "(transitioncancel)": "transition($event, true)",
  },
  template: `<div class="clip">
    <div class="content"><ng-content /></div>
  </div>`,
  styleUrl: "./fold.component.css",
})
export class FoldComponent {
  readonly open = input(false);
  /** Earlier-session reveal: geometry shares one curve, ink staggers from the boundary. */
  readonly motion = input<'default' | 'unroll'>('default');
  readonly enterDelay = input(0);
  readonly exitDelay = input(0);
  protected readonly settled = signal(true);
  protected transition(event: TransitionEvent, settled: boolean): void {
    if (
      event.target === event.currentTarget &&
      event.propertyName === "grid-template-rows"
    )
      this.settled.set(settled);
  }
}
