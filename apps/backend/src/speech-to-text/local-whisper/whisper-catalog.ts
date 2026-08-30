import {
  LOCAL_WHISPER_MODELS,
  type LocalWhisperModelId,
} from '../../settings/settings.types.js';

/**
 * A Whisper build the local engine can download and run.
 *
 * `downloadBytes` is the *actual* transferred size for the files a q8 pipeline
 * pulls — the two ONNX graphs below plus the tokenizer/config JSON — measured
 * against the Hugging Face API rather than estimated. The settings UI shows it
 * before the user commits to a download, so being wrong here is user-visible.
 */
export interface LocalWhisperModelSpec {
  id: LocalWhisperModelId;
  label: string;
  /** Hugging Face repo holding the ONNX export. */
  repo: string;
  downloadBytes: number;
  /** Rough guidance, not a benchmark: how quick this feels for dictation. */
  speed: 'fastest' | 'fast' | 'moderate' | 'slow';
  description: string;
}

/**
 * Quantized (q8) weights: roughly a quarter the size of the fp32 export for a
 * negligible accuracy cost on speech, which is what makes `small` a ~240 MB
 * download instead of a ~970 MB one.
 */
export const WHISPER_ONNX_FILES = [
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
] as const;

/** Config and tokenizer files the pipeline always needs alongside the weights. */
export const WHISPER_SUPPORT_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
] as const;

export const LOCAL_WHISPER_CATALOG: readonly LocalWhisperModelSpec[] = [
  {
    id: 'tiny',
    label: 'Whisper Tiny',
    repo: 'onnx-community/whisper-tiny',
    downloadBytes: 45_000_000,
    speed: 'fastest',
    description:
      'Near-instant, but misspells names and drops words. Good on a slow machine.',
  },
  {
    id: 'base',
    label: 'Whisper Base',
    repo: 'onnx-community/whisper-base',
    downloadBytes: 82_000_000,
    speed: 'fast',
    description:
      'A clear step up from Tiny while staying quick. A reasonable fallback.',
  },
  {
    id: 'small',
    label: 'Whisper Small',
    repo: 'onnx-community/whisper-small',
    downloadBytes: 254_000_000,
    speed: 'moderate',
    description:
      'Accurate enough for technical dictation and still fast on a normal CPU.',
  },
  {
    id: 'large-v3-turbo',
    label: 'Whisper Large v3 Turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    downloadBytes: 1_090_000_000,
    speed: 'slow',
    description:
      'The best accuracy available offline. Needs a fast CPU and ~1 GB of disk.',
  },
];

export function findWhisperModel(
  id: string,
): LocalWhisperModelSpec | undefined {
  return LOCAL_WHISPER_CATALOG.find((model) => model.id === id);
}

/** Guards a value from settings or a request path against the known ids. */
export function isLocalWhisperModelId(
  value: unknown,
): value is LocalWhisperModelId {
  return (
    typeof value === 'string' &&
    LOCAL_WHISPER_MODELS.includes(value as LocalWhisperModelId)
  );
}
