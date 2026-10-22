import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import { ToastComponent } from "./toast.component";
import type { Status } from "../status/status.models";

export interface ToastNotice {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly action?: string;
  readonly tone?: "normal" | "danger";
  readonly glyph?: Status;
  readonly duration?: number;
}

/** The owner retains the notification data and handles Undo; only three are mounted. */
@Component({
  selector: "ex-toast-stack",
  imports: [ToastComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section aria-label="Notifications">
    @for (notice of visible(); track notice.id) {
      <ex-toast
        [title]="notice.title"
        [detail]="notice.detail ?? ''"
        [action]="notice.action ?? ''"
        [tone]="notice.tone ?? 'normal'"
        [glyph]="notice.glyph ?? 'done'"
        [duration]="notice.duration ?? 5000"
        [animate.enter]="ready() ? 'enter' : ''"
        animate.leave="leave"
        (dismissed)="dismissed.emit(notice.id)"
        (actionSelected)="actionSelected.emit(notice.id)"
      />
    }
  </section>`,
  styles: `
    :host {
      position: fixed;
      inset-inline: 0;
      bottom: var(--space-4);
      z-index: 1000;
      pointer-events: none;
    }
    section {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-2);
    }
    ex-toast {
      pointer-events: auto;
    }
    .enter {
      animation: arrive var(--dur-base) var(--ease-out);
    }
    .leave {
      pointer-events: none;
      animation: depart var(--dur-fast) var(--ease-in);
    }
    @keyframes arrive {
      from {
        opacity: 0;
        transform: translateY(var(--space-2));
      }
    }
    @keyframes depart {
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
export class ToastStackComponent {
  readonly notices = input<readonly ToastNotice[]>([]);
  readonly dismissed = output<string>();
  readonly actionSelected = output<string>();
  protected readonly visible = computed(() => this.notices().slice(-3));
  protected readonly ready = signal(false);
  constructor() {
    afterNextRender(() => this.ready.set(true));
  }
}
