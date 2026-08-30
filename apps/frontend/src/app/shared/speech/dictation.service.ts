import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { LocalWhisperService } from '@/shared/services/local-whisper.service';
import { SPEECH_PROVIDERS_REQUIRING_WAV } from '@/shared/models/app-settings.model';
import {
  AudioCaptureSession,
  RecordingTooShortError,
  isRecordingSupported,
} from './audio-capture';
import { LevelMeter } from './level-meter';
import { SpeechToTextApiService } from './speech-to-text-api.service';
import { blobToWav16kMono } from './wav';

export type DictationState =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'transcribing';

/**
 * Something a transcript can be dictated into. Implemented by
 * `DictateTargetDirective`, which owns caret handling so no composer has to.
 */
export interface DictationTarget {
  readonly dictationId: string;
  /** Session the composer belongs to, for worktree and harness context. */
  readonly dictationSessionId: number | null;
  readonly dictationWorktreePath: string | null;
  /** Whether this target can accept text right now (not disabled/detached). */
  canDictate(): boolean;
  /** Inserts at the caret and remembers the range for `replaceDictation`. */
  insertDictation(text: string): void;
  /**
   * Replaces the text `insertDictation` added. Returns false if the user has
   * edited it since, in which case the replacement is dropped.
   */
  replaceDictation(text: string): boolean;
  focusTarget(): void;
  /** Submit the composer, for the auto-send setting. */
  submitTarget?(): void;
}

@Injectable({ providedIn: 'root' })
export class DictationService {
  private readonly api = inject(SpeechToTextApiService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly localWhisper = inject(LocalWhisperService);

  constructor() {
    // The mic's enabled state depends on whether the weights are on disk, so
    // read that once the local engine is the selected provider. `ensureLoaded`
    // is cached per backend origin, so this costs one request, not one per
    // composer that renders a mic button.
    effect(() => {
      if (this.appSettings.settings().speechToText.provider === 'local-whisper') {
        void this.localWhisper.ensureLoaded().catch(() => undefined);
      }
    });
  }

  private session: AudioCaptureSession | null = null;
  private meter: LevelMeter | null = null;
  private target: DictationTarget | null = null;
  /**
   * Incremented on every `start`. A pending `getUserMedia` compares against it
   * after awaiting, so a start that was cancelled — or superseded by a newer
   * one — releases its stream instead of leaving a live microphone behind.
   */
  private startToken = 0;

  readonly state = signal<DictationState>('idle');
  readonly level = signal(0);
  readonly error = signal<string | null>(null);
  readonly activeTargetId = signal<string | null>(null);

  /** Whether the browser can record at all. Constant for the session. */
  readonly supported = isRecordingSupported();

  private readonly speechSettings = computed(
    () => this.appSettings.settings().speechToText,
  );

  /**
   * Dictation needs the feature switch plus whatever the chosen provider runs
   * on: an API key for the cloud services, downloaded weights for the local
   * engine.
   */
  readonly available = computed(() => this.unavailableReason() === null);

  /** Why the mic is unavailable, for a tooltip. `null` when it is usable. */
  readonly unavailableReason = computed(() => {
    if (!this.supported) {
      return 'This browser cannot record audio.';
    }
    const settings = this.appSettings.settings();
    if (!settings.speechToText.enabled) {
      return 'Dictation is off. Turn it on in Settings.';
    }
    if (settings.speechToText.provider === 'local-whisper') {
      if (!this.localWhisper.status().engineAvailable) {
        return 'The local speech engine could not start. See Settings.';
      }
      if (!this.localWhisper.selectedModelReady()) {
        return this.localWhisper.downloadingModel()
          ? 'The speech model is still downloading.'
          : 'Download a speech model in Settings.';
      }
      return null;
    }
    if (
      settings.speechToTextRequiresApiKey &&
      !settings.speechToTextApiKeyConfigured
    ) {
      return 'Add a dictation API key in Settings.';
    }
    return null;
  });

  readonly busy = computed(
    () => this.state() === 'recording' || this.state() === 'transcribing',
  );

  isActive(targetId: string): boolean {
    return this.activeTargetId() === targetId;
  }

  async toggle(target: DictationTarget): Promise<void> {
    if (this.state() === 'recording' && this.isActive(target.dictationId)) {
      await this.stop();
      return;
    }
    await this.start(target);
  }

  async start(target: DictationTarget): Promise<void> {
    if (this.state() !== 'idle') {
      // Only one microphone session app-wide: a second mic button pressed while
      // another is live would otherwise leave an orphaned stream running.
      return;
    }
    const reason = this.unavailableReason();
    if (reason) {
      this.error.set(reason);
      return;
    }

    const token = ++this.startToken;
    this.error.set(null);
    this.target = target;
    this.activeTargetId.set(target.dictationId);
    this.state.set('requesting');

    let session: AudioCaptureSession;
    try {
      session = await AudioCaptureSession.start();
    } catch (error) {
      if (token === this.startToken) {
        this.fail(error);
      }
      return;
    }

    // `cancel()` may have run, or another start begun, while the permission
    // prompt was open. Either way this stream is stale — release it.
    if (token !== this.startToken) {
      session.cancel();
      return;
    }

    this.session = session;
    this.state.set('recording');
    this.attachMeter(session);
  }

  /** Stops recording and inserts the transcript into the active target. */
  async stop(): Promise<void> {
    const session = this.session;
    const target = this.target;
    if (this.state() !== 'recording' || !session || !target) {
      return;
    }

    this.detachMeter();
    this.session = null;
    this.state.set('transcribing');

    let audio: Blob;
    try {
      const recording = await session.stop();
      audio = await this.prepareAudio(recording.blob);
    } catch (error) {
      this.fail(error);
      return;
    }

    try {
      const result = await this.api.transcribe({
        audio,
        sessionId: target.dictationSessionId,
        worktreePath: target.dictationWorktreePath,
      });

      const text = result.text.trim();
      if (!text) {
        this.error.set('No speech was detected.');
        this.reset();
        return;
      }

      if (!target.canDictate()) {
        // The composer went away mid-transcription; don't write into a detached
        // element, but don't report an error either.
        this.reset();
        return;
      }

      target.insertDictation(text);
      target.focusTarget();
      this.reset();

      // Cleanup runs after the words are already on screen, so an opt-in model
      // never delays them. A stale or user-edited range is left untouched.
      if (result.cleanupAvailable) {
        void this.applyCleanup(target, text);
      } else if (this.speechSettings().autoSend) {
        target.submitTarget?.();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** Discards the recording without transcribing. */
  cancel(): void {
    // Invalidates any `getUserMedia` still awaiting a permission decision.
    this.startToken += 1;
    this.detachMeter();
    this.session?.cancel();
    this.session = null;
    this.reset();
  }

  clearError(): void {
    this.error.set(null);
  }

  private async applyCleanup(
    target: DictationTarget,
    rawText: string,
  ): Promise<void> {
    const result = await this.api.cleanup({
      text: rawText,
      sessionId: target.dictationSessionId,
      worktreePath: target.dictationWorktreePath,
    });

    if (result.applied && result.text !== rawText && target.canDictate()) {
      target.replaceDictation(result.text);
    }

    if (this.speechSettings().autoSend) {
      target.submitTarget?.();
    }
  }

  /**
   * OpenRouter takes audio as a chat `input_audio` part, whose documented
   * formats exclude the webm the browser records — so, and only so, transcode.
   */
  private async prepareAudio(blob: Blob): Promise<Blob> {
    if (!SPEECH_PROVIDERS_REQUIRING_WAV.includes(this.speechSettings().provider)) {
      return blob;
    }
    return blobToWav16kMono(blob);
  }

  private attachMeter(session: AudioCaptureSession): void {
    const stream = session.mediaStream;
    if (!stream) {
      return;
    }

    this.meter = LevelMeter.attach(stream, {
      onLevel: (level) => this.level.set(level),
      silenceMs: 2_500,
      onSilence: this.speechSettings().silenceAutoStop
        ? () => void this.stop()
        : undefined,
    });
  }

  private detachMeter(): void {
    this.meter?.stop();
    this.meter = null;
    this.level.set(0);
  }

  private fail(error: unknown): void {
    // Releasing the button before saying anything is a misclick, not a failure.
    if (!(error instanceof RecordingTooShortError)) {
      this.error.set(
        error instanceof Error && error.message
          ? error.message
          : 'Dictation failed.',
      );
    }
    this.detachMeter();
    this.session?.cancel();
    this.session = null;
    this.reset();
  }

  private reset(): void {
    this.state.set('idle');
    this.activeTargetId.set(null);
    this.target = null;
    this.level.set(0);
  }
}
