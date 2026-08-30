import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCircleCheck,
  lucideDownload,
  lucideHardDrive,
  lucideTrash2,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardProgressBarComponent } from '@/shared/components/progress-bar';
import type { LocalWhisperModelId } from '@/shared/models/app-settings.model';
import {
  LOCAL_WHISPER_BACKEND_LABELS,
  LOCAL_WHISPER_SPEED_LABELS,
  formatModelSize,
  type LocalWhisperModel,
} from '@/shared/models/local-whisper.model';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { LocalWhisperService } from '@/shared/services/local-whisper.service';
import { mergeClasses } from '@/shared/utils/merge-classes';

/**
 * Model management for offline dictation.
 *
 * The panel is deliberately a list of concrete choices rather than a
 * download-then-configure wizard: a model is both the thing you pick and the
 * thing you download, so one row owns both actions and the progress it makes.
 */
@Component({
  selector: 'app-local-whisper-settings',
  standalone: true,
  imports: [NgIcon, ZardButtonComponent, ZardProgressBarComponent],
  templateUrl: './local-whisper.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'grid gap-3' },
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCircleCheck,
      lucideDownload,
      lucideHardDrive,
      lucideTrash2,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
})
export class LocalWhisperSettingsComponent {
  private readonly localWhisper = inject(LocalWhisperService);
  private readonly appSettings = inject(AppSettingsService);

  readonly speedLabels = LOCAL_WHISPER_SPEED_LABELS;
  readonly formatSize = formatModelSize;

  /** Guards the per-row buttons while a request is in flight. */
  readonly pending = signal<LocalWhisperModelId | null>(null);

  readonly status = this.localWhisper.status;
  readonly models = this.localWhisper.models;
  readonly loading = this.localWhisper.loading;
  readonly selectedId = computed(
    () => this.appSettings.settings().speechToText.localModel,
  );

  readonly anyReady = computed(() =>
    this.models().some((model) => model.status === 'ready'),
  );

  /** Drives the "nothing installed yet" call to action. */
  readonly recommended = computed(
    () => this.models().find((model) => model.id === 'small') ?? null,
  );

  readonly selectedReady = this.localWhisper.selectedModelReady;
  readonly backendKind = this.localWhisper.backendKind;

  /** "this machine" / "your WSL backend" / "the remote backend". */
  readonly backendLabel = computed(
    () => LOCAL_WHISPER_BACKEND_LABELS[this.backendKind()],
  );

  /**
   * Only a local backend can honestly claim the audio never leaves the device.
   * On WSL or SSH the recording travels to that host — still your own hardware,
   * still no third party, but a different sentence.
   */
  readonly privacyNote = computed(() => {
    switch (this.backendKind()) {
      case 'local':
        return 'No API key, and no audio leaves this device.';
      case 'wsl':
        return 'No API key. Recordings go to your WSL backend and no further.';
      default:
        return 'No API key. Recordings go to your own backend over the connection you already use, and no further.';
    }
  });

  /** Disables the download buttons when the engine cannot run at all. */
  readonly engineAvailable = computed(() => this.status().engineAvailable);

  constructor() {
    // Streams download progress only while this panel is on screen; the
    // download itself belongs to the backend and keeps running either way.
    const stop = this.localWhisper.watch();
    inject(DestroyRef).onDestroy(stop);
  }

  isSelected(model: LocalWhisperModel): boolean {
    return model.id === this.selectedId();
  }

  /**
   * Built here rather than as `[class.x]` bindings because Tailwind's opacity
   * syntax (`bg-primary/5`) is not a valid class-binding name.
   */
  rowClasses(model: LocalWhisperModel): string {
    return mergeClasses(
      'block w-full rounded-lg border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
      this.isSelected(model)
        ? 'border-primary bg-primary/5'
        : 'border-border hover:bg-accent/40',
      this.pending() ? 'cursor-progress' : 'cursor-pointer',
    );
  }

  /**
   * Picking a row is the whole interaction: it selects the model for dictation
   * and, if the weights are missing, starts fetching them. Splitting those into
   * two clicks would only ever be two clicks.
   */
  async choose(model: LocalWhisperModel): Promise<void> {
    if (this.pending()) {
      return;
    }
    if (!this.isSelected(model)) {
      await this.select(model.id);
    }
    if (model.status === 'not-downloaded' || model.status === 'error') {
      await this.download(model);
    }
  }

  async select(model: LocalWhisperModelId): Promise<void> {
    try {
      await this.appSettings.saveSpeechToText({ localModel: model });
    } catch {
      toast.error(this.appSettings.error() ?? 'Could not save settings.');
    }
  }

  async download(model: LocalWhisperModel): Promise<void> {
    this.pending.set(model.id);
    try {
      await this.localWhisper.startDownload(model.id);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not start the download.',
      );
    } finally {
      this.pending.set(null);
    }
  }

  async cancel(model: LocalWhisperModel): Promise<void> {
    this.pending.set(model.id);
    try {
      await this.localWhisper.cancelDownload(model.id);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not cancel the download.',
      );
    } finally {
      this.pending.set(null);
    }
  }

  async remove(model: LocalWhisperModel): Promise<void> {
    this.pending.set(model.id);
    try {
      await this.localWhisper.remove(model.id);
      toast.success(`${model.label} deleted`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not delete the model.',
      );
    } finally {
      this.pending.set(null);
    }
  }

  /** "142 MB of 254 MB" reads better under a bar than a bare percentage. */
  progressLabel(model: LocalWhisperModel): string {
    return `${formatModelSize(model.loadedBytes)} of ${formatModelSize(model.downloadBytes)}`;
  }
}
