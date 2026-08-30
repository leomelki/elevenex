import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { OverlayModule } from '@angular/cdk/overlay';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideDownload,
  lucideLoaderCircle,
  lucideMic,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardProgressBarComponent } from '@/shared/components/progress-bar';
import {
  LOCAL_WHISPER_BACKEND_LABELS,
  formatModelSize,
} from '@/shared/models/local-whisper.model';
import { LocalWhisperService } from '@/shared/services/local-whisper.service';
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
  imports: [NgIcon, OverlayModule, RouterLink, ZardButtonComponent, ZardProgressBarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCircleCheck,
      lucideDownload,
      lucideLoaderCircle,
      lucideMic,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
  templateUrl: './dictation-button.component.html',
  styleUrl: './dictation-button.component.scss',
})
export class DictationButtonComponent {
  private readonly dictation = inject(DictationService);
  private readonly localWhisper = inject(LocalWhisperService);

  readonly target = input.required<DictationTarget>();
  readonly size = input<'sm' | 'md'>('sm');
  /** Set while the composer itself is unusable, e.g. a disconnected session. */
  readonly disabled = input(false);

  private readonly triggerRef =
    viewChild<ElementRef<HTMLButtonElement>>('trigger');

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

  /**
   * True when dictation is otherwise ready except the local Whisper build has
   * never been downloaded. Rather than just refusing, the button stays
   * clickable and opens an explainer with a one-click download instead of the
   * dead end everything else here gets.
   */
  readonly needsSetup = this.dictation.localModelSetupNeeded;

  readonly popoverOpen = signal(false);
  /** True once the download started from *this* popover, so a later "ready"
   * status is shown as "you're done" rather than reopening the initial pitch. */
  private readonly downloadStartedHere = signal(false);
  readonly pending = signal(false);

  readonly selectedModel = this.localWhisper.selectedModel;
  readonly backendLabel = computed(
    () => LOCAL_WHISPER_BACKEND_LABELS[this.localWhisper.backendKind()],
  );
  readonly formatSize = formatModelSize;

  readonly setupReady = computed(
    () =>
      this.downloadStartedHere() && this.selectedModel()?.status === 'ready',
  );
  readonly setupDownloading = computed(
    () => this.selectedModel()?.status === 'downloading',
  );
  readonly setupError = computed(() => this.selectedModel()?.error ?? null);

  readonly isDisabled = computed(() => {
    if (this.disabled() || this.blockedByOther() || this.transcribing()) {
      return true;
    }
    if (this.needsSetup()) {
      // Clickable so it can open the explainer below instead of doing nothing.
      return false;
    }
    return this.unavailableReason() !== null;
  });

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
    if (this.needsSetup()) {
      return 'Set up dictation — click to download the speech model';
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

  constructor() {
    // Closing the popover mid-download must not cancel it (it belongs to the
    // backend and keeps running), but the "you're done" framing is only right
    // for the download this popover itself kicked off.
    effect(() => {
      if (!this.popoverOpen()) {
        this.downloadStartedHere.set(false);
      }
    });

    // Progress and the eventual "ready" status only arrive over the shared
    // status stream — without watching it here, the popover would freeze at
    // whatever byte count the download's start response happened to report.
    effect((onCleanup) => {
      if (!this.popoverOpen()) {
        return;
      }
      const stopWatching = this.localWhisper.watch();
      onCleanup(stopWatching);
    });
  }

  protected onPointerDown(event: PointerEvent): void {
    if (this.isDisabled() || event.button !== 0) {
      return;
    }
    if (this.needsSetup()) {
      // Handled as a plain click on release; there is no hold gesture here.
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
    if (this.isDisabled()) {
      return;
    }
    if (this.needsSetup()) {
      this.openPopover();
      return;
    }
    void this.run(() => this.dictation.toggle(this.target()));
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
    if (this.isDisabled()) {
      return;
    }
    if (this.needsSetup()) {
      this.openPopover();
      return;
    }
    void this.run(() => this.dictation.toggle(this.target()));
  }

  protected openPopover(): void {
    void this.localWhisper.ensureLoaded().catch(() => undefined);
    this.popoverOpen.set(true);
  }

  protected closePopover(focusTrigger = true): void {
    this.popoverOpen.set(false);
    if (focusTrigger) {
      this.triggerRef()?.nativeElement.focus();
    }
  }

  protected async download(): Promise<void> {
    const model = this.selectedModel();
    if (!model || this.pending()) {
      return;
    }
    this.pending.set(true);
    this.downloadStartedHere.set(true);
    try {
      await this.localWhisper.startDownload(model.id);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not start the download.',
      );
    } finally {
      this.pending.set(false);
    }
  }

  protected async cancelDownload(): Promise<void> {
    const model = this.selectedModel();
    if (!model || this.pending()) {
      return;
    }
    this.pending.set(true);
    try {
      await this.localWhisper.cancelDownload(model.id);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not cancel the download.',
      );
    } finally {
      this.pending.set(false);
    }
  }

  /** "142 MB of 254 MB" reads better under a bar than a bare percentage. */
  protected progressLabel(): string {
    const model = this.selectedModel();
    if (!model) {
      return '';
    }
    return `${formatModelSize(model.loadedBytes)} of ${formatModelSize(model.downloadBytes)}`;
  }

  /** The model just finished downloading — go straight into dictating with it. */
  protected async startNow(): Promise<void> {
    this.closePopover(false);
    await this.run(() => this.dictation.start(this.target()));
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
