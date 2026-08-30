/**
 * Microphone capture for dictation.
 *
 * Uses the native `MediaRecorder` rather than an `AudioWorklet` PCM pipeline:
 * the two STT routes we default to (ElevenLabs, and anything speaking OpenAI's
 * `/audio/transcriptions`) accept the browser's own container directly, so
 * there is nothing to convert. Opus keeps a 30 s dictation around 350 KB, which
 * matters because the backend may be reached over an SSH/WSL tunnel.
 *
 * See `blobToWav16kMono` in `./wav` for the one provider that needs a
 * different format.
 */

/** Preference order; the first supported entry wins. */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  // Safari records mp4/aac and supports nothing above.
  'audio/mp4',
];

/** Opus at this rate is transparent for speech and keeps uploads small. */
const AUDIO_BITS_PER_SECOND = 32_000;

/** Below this, the user almost certainly clicked by mistake. */
export const MIN_RECORDING_MS = 350;

export interface Recording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export class MicrophonePermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrophonePermissionError';
  }
}

export class RecordingTooShortError extends Error {
  constructor() {
    super('That was too short to transcribe. Hold the mic a moment longer.');
    this.name = 'RecordingTooShortError';
  }
}

/** `null` when the browser has no usable recording format at all. */
export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') {
    return null;
  }
  for (const mimeType of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return null;
}

export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    pickMimeType() !== null
  );
}

/**
 * One recording session. Owns the `MediaStream` and guarantees the microphone
 * is released on every exit path — a live mic indicator left on after a failed
 * dictation reads as a privacy bug.
 */
export class AudioCaptureSession {
  private readonly chunks: Blob[] = [];
  private readonly startedAt = performance.now();
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private settled = false;

  private constructor(private readonly mimeType: string) {}

  static async start(): Promise<AudioCaptureSession> {
    const mimeType = pickMimeType();
    if (!mimeType) {
      throw new Error('This browser cannot record audio.');
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw new MicrophonePermissionError(describeGetUserMediaError(error));
    }

    const session = new AudioCaptureSession(mimeType);
    session.stream = stream;
    session.recorder = new MediaRecorder(stream, {
      mimeType,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    session.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        session.chunks.push(event.data);
      }
    });
    session.recorder.start();
    return session;
  }

  /** The live stream, for the level meter. */
  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  get elapsedMs(): number {
    return performance.now() - this.startedAt;
  }

  /** Stops recording and resolves with the audio. Releases the microphone. */
  async stop(): Promise<Recording> {
    if (this.settled) {
      throw new Error('This recording has already finished.');
    }
    this.settled = true;

    const recorder = this.recorder;
    if (!recorder) {
      this.release();
      throw new Error('Recording was never started.');
    }

    const durationMs = this.elapsedMs;
    try {
      await new Promise<void>((resolve) => {
        if (recorder.state === 'inactive') {
          resolve();
          return;
        }
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.stop();
      });
    } finally {
      this.release();
    }

    if (durationMs < MIN_RECORDING_MS) {
      throw new RecordingTooShortError();
    }

    const blob = new Blob(this.chunks, { type: this.mimeType });
    if (blob.size === 0) {
      throw new Error('No audio was captured. Check your microphone input.');
    }

    return { blob, mimeType: this.mimeType, durationMs };
  }

  /** Discards the recording and releases the microphone. Safe to call twice. */
  cancel(): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    try {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop();
      }
    } catch {
      // Already stopped; releasing the tracks below is what actually matters.
    }
    this.chunks.length = 0;
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
  }
}

function describeGetUserMediaError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was denied. Allow it in your browser or system settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one and try again.';
    case 'NotReadableError':
      return 'The microphone is already in use by another application.';
    default:
      return `Could not start the microphone: ${(error as Error)?.message ?? 'unknown error'}`;
  }
}
