/**
 * Live input level for the recording animation and silence auto-stop.
 *
 * An `AnalyserNode` tapped off the same `MediaStream` the recorder uses — no
 * `AudioWorklet` needed, and it costs nothing when nobody is recording.
 */

/** Below this RMS the room counts as quiet. Tuned for a laptop mic at arm's length. */
const SILENCE_RMS_THRESHOLD = 0.012;

/** Don't arm the auto-stop until the user has actually said something. */
const SPEECH_RMS_THRESHOLD = 0.03;

export interface LevelMeterOptions {
  /** Called on every animation frame with a 0..1 level. */
  onLevel: (level: number) => void;
  /** Called once, after `silenceMs` of quiet that followed detected speech. */
  onSilence?: () => void;
  silenceMs?: number;
}

export class LevelMeter {
  private context: AudioContext | null = null;
  private frameHandle: number | null = null;
  private heardSpeech = false;
  private quietSince: number | null = null;
  private stopped = false;

  private constructor(private readonly options: LevelMeterOptions) {}

  /**
   * Never throws: a missing Web Audio implementation costs the animation and
   * the auto-stop, not the dictation itself.
   */
  static attach(
    stream: MediaStream,
    options: LevelMeterOptions,
  ): LevelMeter | null {
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextCtor) {
      return null;
    }

    const meter = new LevelMeter(options);
    try {
      meter.run(new AudioContextCtor(), stream);
      return meter;
    } catch {
      meter.stop();
      return null;
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private run(context: AudioContext, stream: MediaStream): void {
    this.context = context;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    // Deliberately not connected to the destination — that would echo the mic
    // back through the speakers.

    const samples = new Float32Array(analyser.fftSize);
    const silenceMs = this.options.silenceMs ?? 2_500;

    const tick = () => {
      if (this.stopped) {
        return;
      }
      analyser.getFloatTimeDomainData(samples);

      let sumOfSquares = 0;
      for (let i = 0; i < samples.length; i += 1) {
        sumOfSquares += samples[i]! * samples[i]!;
      }
      const rms = Math.sqrt(sumOfSquares / samples.length);

      // Speech RMS rarely exceeds ~0.3, so scale to that for a meter that
      // actually moves instead of hugging the bottom of its range.
      this.options.onLevel(Math.min(1, rms / 0.3));

      if (rms >= SPEECH_RMS_THRESHOLD) {
        this.heardSpeech = true;
        this.quietSince = null;
      } else if (this.heardSpeech && rms < SILENCE_RMS_THRESHOLD) {
        this.quietSince ??= performance.now();
        if (performance.now() - this.quietSince >= silenceMs) {
          this.stop();
          this.options.onSilence?.();
          return;
        }
      } else {
        this.quietSince = null;
      }

      this.frameHandle = requestAnimationFrame(tick);
    };

    this.frameHandle = requestAnimationFrame(tick);
  }
}
