import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle, lucideMic, lucideSquare } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { DictationService, type DictationTarget } from './dictation.service';

/**
 * The single microphone affordance, shared by every prompt composer so they all
 * look and behave identically. Sizes match the two toolbar scales in the app:
 * the 14px icon buttons in the session composer and the 2rem circular button in
 * the command bar.
 */
@Component({
  selector: 'app-dictation-button',
  standalone: true,
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideLoaderCircle, lucideMic, lucideSquare }),
  ],
  templateUrl: './dictation-button.component.html',
  styleUrl: './dictation-button.component.scss',
})
export class DictationButtonComponent {
  private readonly dictation = inject(DictationService);

  readonly target = input.required<DictationTarget>();
  readonly size = input<'sm' | 'md'>('sm');
  /** Set while the composer itself is unusable, e.g. a disconnected session. */
  readonly disabled = input(false);

  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once a press has been held long enough to count as push-to-talk. */
  private holding = false;

  readonly level = this.dictation.level;

  readonly isActive = computed(() =>
    this.dictation.isActive(this.target().dictationId),
  );
  readonly recording = computed(
    () => this.isActive() && this.dictation.state() === 'recording',
  );
  readonly transcribing = computed(
    () => this.isActive() && this.dictation.state() === 'transcribing',
  );
  /** Another composer is using the microphone. */
  readonly blockedByOther = computed(
    () => this.dictation.busy() && !this.isActive(),
  );

  readonly unavailableReason = this.dictation.unavailableReason;

  readonly isDisabled = computed(
    () =>
      this.disabled() ||
      this.unavailableReason() !== null ||
      this.blockedByOther() ||
      this.transcribing(),
  );

  readonly label = computed(() => {
    if (this.recording()) {
      return 'Stop dictating';
    }
    if (this.transcribing()) {
      return 'Transcribing…';
    }
    if (this.blockedByOther()) {
      return 'Another composer is dictating';
    }
    return this.unavailableReason() ?? 'Dictate (Ctrl+Shift+M) — hold to talk';
  });

  /**
   * Three level bars, each lit from a different slice of the range so the meter
   * reads as a level rather than three copies of the same value.
   */
  readonly bars = computed(() => {
    const level = this.level();
    return [0.12, 0.34, 0.6].map((threshold) =>
      Math.max(0.25, Math.min(1, (level - threshold) / 0.3 + 0.35)),
    );
  });

  protected onPointerDown(event: PointerEvent): void {
    if (this.isDisabled() || event.button !== 0) {
      return;
    }
    // A held press is push-to-talk; a quick click is a toggle. Deciding on a
    // timer keeps both gestures on one button without a modifier.
    this.holding = false;
    this.pressTimer = setTimeout(() => {
      this.holding = true;
      if (!this.recording()) {
        void this.run(() => this.dictation.start(this.target()));
      }
    }, 250);
  }

  protected onPointerUp(): void {
    this.clearTimer();
    if (this.holding) {
      this.endHold();
      return;
    }
    if (!this.isDisabled()) {
      void this.run(() => this.dictation.toggle(this.target()));
    }
  }

  /** Releasing outside the button still ends a push-to-talk. */
  protected onPointerLeave(): void {
    this.clearTimer();
    if (this.holding) {
      this.endHold();
    }
  }

  private endHold(): void {
    this.holding = false;
    if (this.recording()) {
      void this.run(() => this.dictation.stop());
      return;
    }
    // Released while the permission prompt was still open. Cancelling here is
    // what stops `start()` from leaving a live microphone behind once the user
    // finally answers the prompt.
    if (this.isActive()) {
      this.dictation.cancel();
    }
  }

  /** Keyboard activation is always a toggle; there is no held-key gesture. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    if (!this.isDisabled()) {
      void this.run(() => this.dictation.toggle(this.target()));
    }
  }

  private clearTimer(): void {
    if (this.pressTimer !== null) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
  }

  /**
   * Surfaces dictation errors as toasts. The service holds the message so a
   * failure that happens while the composer is unmounted is not lost silently.
   */
  private async run(action: () => Promise<void>): Promise<void> {
    await action();
    const error = this.dictation.error();
    if (error) {
      toast.error(error);
      this.dictation.clearError();
    }
  }
}
