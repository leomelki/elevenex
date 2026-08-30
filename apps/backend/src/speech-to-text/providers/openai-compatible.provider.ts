import {
  MAX_KEYTERMS,
  SpeechToTextProvider,
  SpeechToTextProviderError,
  TranscribeAudioInput,
  extensionForMimeType,
} from '../speech-to-text.types.js';

/**
 * Any service exposing OpenAI's `/audio/transcriptions`: OpenAI itself, Groq,
 * DeepInfra, LM Studio, vLLM, and later a local whisper.cpp server — the route
 * is just a base URL. OpenAI documents flac, mp3, mp4, mpeg, mpga, m4a, ogg,
 * wav and webm, so browser recordings upload as-is.
 */
export class OpenAiCompatibleSpeechToTextProvider
  implements SpeechToTextProvider
{
  readonly id = 'openai-compatible' as const;

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

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async transcribe(input: TranscribeAudioInput): Promise<string> {
    const form = new FormData();
    form.append('model', input.model);
    form.append(
      'file',
      new Blob([new Uint8Array(input.audio)], { type: input.mimeType }),
      `dictation.${extensionForMimeType(input.mimeType)}`,
    );
    if (input.language) {
      form.append('language', input.language);
    }
    if (input.keyterms.length > 0) {
      // Whisper-style models take a free-text prompt as a decoding hint; a bare
      // comma list of identifiers is the documented way to bias vocabulary.
      form.append(
        'prompt',
        input.keyterms.slice(0, MAX_KEYTERMS).join(', '),
      );
    }

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
    } catch (error) {
      throw new SpeechToTextProviderError(
        `Could not reach ${this.baseUrl}: ${(error as Error).message}`,
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
        'The transcription endpoint returned an unexpected response shape.',
      );
    }
    return payload.text.trim();
  }
}

/** Deliberately does not include the response body, which can echo the key. */
function describeFailure(status: number): string {
  if (status === 401 || status === 403) {
    return 'The transcription endpoint rejected the API key. Check it in Settings.';
  }
  if (status === 404) {
    return 'No /audio/transcriptions endpoint at that base URL. Check it in Settings.';
  }
  if (status === 400 || status === 422) {
    return 'The transcription endpoint rejected the audio or model. Check the model id in Settings.';
  }
  if (status === 429) {
    return 'Transcription rate limit reached. Try again in a moment.';
  }
  return `The transcription endpoint returned HTTP ${status}.`;
}
