import { LocalWhisperModelId } from './app-settings.model';

export type LocalWhisperModelStatus =
  | 'not-downloaded'
  | 'downloading'
  | 'ready'
  | 'error';

export type LocalWhisperSpeed = 'fastest' | 'fast' | 'moderate' | 'slow';

/**
 * One downloadable Whisper build plus this machine's state for it. The catalog
 * is served rather than duplicated here so download sizes and labels stay in
 * one place.
 */
export interface LocalWhisperModel {
  id: LocalWhisperModelId;
  label: string;
  repo: string;
  downloadBytes: number;
  speed: LocalWhisperSpeed;
  description: string;
  status: LocalWhisperModelStatus;
  loadedBytes: number;
  /** 0–1. */
  progress: number;
  currentFile: string | null;
  error: string | null;
  loadedInMemory: boolean;
}

/**
 * Where the engine actually runs. Whisper runs inside the backend, so this is
 * the difference between "nothing leaves this device" and "the recording goes
 * to your own remote host".
 */
export type LocalWhisperBackendKind = 'local' | 'wsl' | 'remote';

/** Names the machine in prose, for sentences like "downloaded to {x}". */
export const LOCAL_WHISPER_BACKEND_LABELS: Record<
  LocalWhisperBackendKind,
  string
> = {
  local: 'this machine',
  wsl: 'your WSL backend',
  remote: 'the remote backend',
};

export interface LocalWhisperStatus {
  engineAvailable: boolean;
  engineError: string | null;
  cacheDir: string;
  selectedModel: LocalWhisperModelId;
  models: LocalWhisperModel[];
}

export const EMPTY_LOCAL_WHISPER_STATUS: LocalWhisperStatus = {
  engineAvailable: true,
  engineError: null,
  cacheDir: '',
  selectedModel: 'small',
  models: [],
};

export const LOCAL_WHISPER_SPEED_LABELS: Record<LocalWhisperSpeed, string> = {
  fastest: 'Fastest',
  fast: 'Fast',
  moderate: 'Balanced',
  slow: 'Most accurate',
};

/** Download sizes are big enough that MB/GB, not bytes, is what reads. */
export function formatModelSize(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  }
  return `${Math.round(bytes / 1_000_000)} MB`;
}
