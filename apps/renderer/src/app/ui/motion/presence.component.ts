import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  input,
  signal,
} from "@angular/core";
@Component({
  selector: "ex-presence",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (show()) {
    <div [animate.enter]="ready() ? 'enter' : ''" animate.leave="leave">
      <ng-content />
    </div>
  }`,
  styles: `
    :host {
      display: contents;
    }
    .enter {
      animation: enter var(--dur-base) var(--ease-out);
    }
    .leave {
      pointer-events: none;
      animation: leave var(--dur-fast) var(--ease-in);
    }
    @keyframes enter {
      from {
        opacity: 0;
        transform: translateY(var(--space-1));
      }
    }
    @keyframes leave {
      to {
        opacity: 0;
        transform: translateY(var(--space-1));
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .enter,
      .leave {
        animation: none;
      }
    }
  `,
})
export class PresenceComponent {
  readonly show = input(false);
  protected readonly ready = signal(false);
  constructor() {
    afterNextRender(() => this.ready.set(true));
  }
}
