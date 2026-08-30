import type { LocalWhisperModelId } from '../../settings/settings.types.js';
import type { LocalWhisperService } from '../local-whisper/local-whisper.service.js';
import {
  SpeechToTextProvider,
  SpeechToTextProviderError,
  TranscribeAudioInput,
} from '../speech-to-text.types.js';
import { WavDecodeError, decodeWavToMono16k } from '../wav-decode.js';

/**
 * Whisper running in this process through ONNX Runtime. Nothing leaves the
 * machine and there is no API key, at the cost of a one-time model download.
 *
 * Only WAV is accepted: the client transcodes for this provider (see
 * `SPEECH_PROVIDERS_REQUIRING_WAV`) using the browser's own decoder, which
 * keeps codec handling off the backend entirely.
 */
export class LocalWhisperSpeechToTextProvider implements SpeechToTextProvider {
  readonly id = 'local-whisper' as const;

  readonly acceptedMimeTypes = [
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
  ] as const;

  constructor(private readonly engine: LocalWhisperService) {}

  async transcribe(input: TranscribeAudioInput): Promise<string> {
    let samples: Float32Array;
    try {
      samples = decodeWavToMono16k(input.audio);
    } catch (error) {
      if (error instanceof WavDecodeError) {
        throw new SpeechToTextProviderError(error.message);
      }
      throw error;
    }

    if (samples.length === 0) {
      throw new SpeechToTextProviderError('The recording contained no audio.');
    }

    // Keyterm biasing is deliberately not applied here. Whisper's only
    // equivalent is an initial prompt, which it readily echoes into the
    // transcript; transcript cleanup is the supported way to fix identifiers
    // for this provider.
    return this.engine.transcribe({
      samples,
      model: input.model as LocalWhisperModelId,
      language: input.language,
    });
  }
}
