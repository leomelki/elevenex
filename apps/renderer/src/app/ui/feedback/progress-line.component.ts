import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
@Component({
  selector: "ex-progress-line",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: "progressbar",
    "[attr.aria-label]": "label()",
    "[attr.aria-valuenow]": "amount() === undefined ? null : amount()! * 100",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "[class.indeterminate]": "amount() === undefined",
  },
  template: `<span
    [style.transform]="
      amount() === undefined ? null : 'scaleX(' + amount() + ')'
    "
  ></span>`,
  styles: `
    :host {
      position: relative;
      display: block;
      height: 2px;
      border-radius: var(--radius-full);
      background: var(--line);
      overflow: hidden;
    }
    span {
      position: absolute;
      inset: 0;
      background: var(--progress-color, var(--accent));
      transform-origin: left;
      transition: var(--progress-transition, transform var(--dur-slow) var(--ease-in-out));
    }
    :host(.indeterminate) span {
      animation: glide 1.3s var(--ease-in-out) infinite;
    }
    @keyframes glide {
      from {
        transform: translateX(-50%) scaleX(0.3);
      }
      to {
        transform: translateX(110%) scaleX(0.3);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      span {
        transition: none;
      }
      :host(.indeterminate) span {
        animation: none;
        transform: scaleX(0.3);
      }
    }
  `,
})
export class ProgressLineComponent {
  readonly value = input<number>();
  readonly label = input("Loading");
  protected readonly amount = computed(() => {
    const value = this.value();
    return value === undefined
      ? undefined
      : Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  });
}
