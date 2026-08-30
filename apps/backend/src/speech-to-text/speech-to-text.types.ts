import type { SpeechToTextProviderId } from '../settings/settings.types.js';

/**
 * Audio handed to a provider. `mimeType` is whatever the browser's
 * `MediaRecorder` produced (or `audio/wav` when the client transcoded for a
 * provider that cannot take the native format).
 */
export interface TranscribeAudioInput {
  audio: Buffer;
  mimeType: string;
  model: string;
  /**
   * The one code this provider should be pinned to, or `null` to let it detect.
   * Already `null` when the user allowed several languages, since these
   * providers take a single code and their own detection beats picking one.
   */
  language: string | null;
  /**
   * Every language the user allowed, most likely first. Only the local engine
   * uses this: it can restrict its own detection to the set. Empty means the
   * user did not restrict anything.
   */
  languages: string[];
  /** Vocabulary bias terms — repo, branch and file names from the session. */
  keyterms: string[];
}

export interface SpeechToTextProvider {
  readonly id: SpeechToTextProviderId;
  /**
   * Formats this provider accepts. Checked before any upstream call so a
   * mismatch is a clear local error instead of an opaque 400 from the API.
   * Base types only — parameters like `;codecs=opus` are stripped first.
   */
  readonly acceptedMimeTypes: readonly string[];
  transcribe(input: TranscribeAudioInput): Promise<string>;
}

export interface TranscriptionResult {
  /** Exactly what the STT provider returned. Cleanup is a separate call. */
  text: string;
  provider: SpeechToTextProviderId;
  model: string;
  transcribeMs: number;
  /** Whether a follow-up `POST /speech-to-text/cleanup` would do anything. */
  cleanupAvailable: boolean;
}

/** Audio bigger than this is rejected before we spend an upstream call on it. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Cap on vocabulary-bias terms sent upstream. */
export const MAX_KEYTERMS = 200;

/**
 * Raised by providers for problems the user can act on. The message is shown
 * verbatim in the UI, so it must never contain an upstream response body (which
 * can echo the API key back).
 */
export class SpeechToTextProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SpeechToTextProviderError';
  }
}

/** Strips `;codecs=…` so `audio/webm;codecs=opus` matches `audio/webm`. */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0]!.trim().toLowerCase();
}

/**
 * Filename extension for a MIME type. Providers sniff the multipart filename as
 * well as its content type, so sending `blob` with no extension makes several
 * of them reject otherwise-valid audio.
 */
export function extensionForMimeType(mimeType: string): string {
  switch (baseMimeType(mimeType)) {
    case 'audio/webm':
      return 'webm';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/flac':
      return 'flac';
    default:
      return 'bin';
  }
}
