import {
  MAX_KEYTERMS,
  SpeechToTextProvider,
  SpeechToTextProviderError,
  TranscribeAudioInput,
  extensionForMimeType,
} from '../speech-to-text.types.js';

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

/**
 * ElevenLabs Scribe. Documented as accepting "all major audio and video
 * formats", so the browser's native recording goes through untouched.
 */
export class ElevenLabsSpeechToTextProvider implements SpeechToTextProvider {
  readonly id = 'elevenlabs' as const;

  readonly acceptedMimeTypes = [
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
    'audio/x-m4a',
    'audio/mpeg',
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
    'audio/flac',
  ] as const;

  constructor(private readonly apiKey: string) {}

  async transcribe(input: TranscribeAudioInput): Promise<string> {
    const form = new FormData();
    form.append('model_id', input.model);
    form.append(
      'file',
      new Blob([new Uint8Array(input.audio)], { type: input.mimeType }),
      `dictation.${extensionForMimeType(input.mimeType)}`,
    );
    if (input.language) {
      form.append('language_code', input.language);
    }
    if (input.keyterms.length > 0) {
      // Biasing carries a surcharge upstream, so the caller only populates this
      // when the user has opted in.
      form.append('keyterms', JSON.stringify(input.keyterms.slice(0, MAX_KEYTERMS)));
    }

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey },
        body: form,
      });
    } catch (error) {
      throw new SpeechToTextProviderError(
        `Could not reach ElevenLabs: ${(error as Error).message}`,
      );
    }

    if (!response.ok) {
      throw new SpeechToTextProviderError(
        describeFailure(response.status),
        response.status,
      );
    }

    const payload = (await response.json()) as { text?: unknown };
    if (typeof payload.text !== 'string') {
      throw new SpeechToTextProviderError(
        'ElevenLabs returned an unexpected response shape.',
      );
    }
    return payload.text.trim();
  }
}

/** Deliberately does not include the response body, which can echo the key. */
function describeFailure(status: number): string {
  if (status === 401 || status === 403) {
    return 'ElevenLabs rejected the API key. Check it in Settings.';
  }
  if (status === 422) {
    return 'ElevenLabs rejected the audio or model. Check the model id in Settings.';
  }
  if (status === 429) {
    return 'ElevenLabs rate limit reached. Try again in a moment.';
  }
  return `ElevenLabs returned HTTP ${status}.`;
}
