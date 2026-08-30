import type { LocalWhisperModelId } from '../../settings/settings.types.js';
import type { LocalWhisperModelSpec } from './whisper-catalog.js';

export type LocalWhisperModelStatus =
  | 'not-downloaded'
  | 'downloading'
  | 'ready'
  | 'error';

/** One catalog entry plus whatever this machine currently has on disk. */
export interface LocalWhisperModelState extends LocalWhisperModelSpec {
  status: LocalWhisperModelStatus;
  /** Bytes fetched so far while `downloading`, else 0. */
  loadedBytes: number;
  /** 0–1. Uses the catalog size as the denominator so the bar never jumps back. */
  progress: number;
  /** File currently being fetched, for a subtitle under the progress bar. */
  currentFile: string | null;
  /** Why the last download or load failed. Cleared when one succeeds. */
  error: string | null;
  /** True once weights are on disk and a pipeline has loaded from them. */
  loadedInMemory: boolean;
}

export interface LocalWhisperStatus {
  /** False when the ONNX runtime cannot load here (unsupported CPU/platform). */
  engineAvailable: boolean;
  /** Why the engine is unusable, when `engineAvailable` is false. */
  engineError: string | null;
  /** Where weights are stored, shown so the user knows what to delete. */
  cacheDir: string;
  /** The build dictation will use, from settings. */
  selectedModel: LocalWhisperModelId;
  models: LocalWhisperModelState[];
}

export interface LocalWhisperTranscribeInput {
  /** 16 kHz mono PCM. */
  samples: Float32Array;
  model: LocalWhisperModelId;
  /** ISO-639 code, or `null` to let Whisper detect it. */
  language: string | null;
}
