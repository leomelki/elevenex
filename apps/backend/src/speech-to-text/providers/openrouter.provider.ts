import {
  MAX_KEYTERMS,
  SpeechToTextProvider,
  SpeechToTextProviderError,
  TranscribeAudioInput,
  baseMimeType,
} from '../speech-to-text.types.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * OpenRouter has no `/audio/transcriptions` — it is a chat router. Audio goes
 * in as an `input_audio` content part on a chat completion, so transcription
 * here is prompting rather than a dedicated STT model: the reply needs
 * normalizing, and audio support varies per model.
 *
 * Its documented formats are wav, mp3, aiff, aac, ogg, flac, m4a, pcm16 and
 * pcm24 — notably **not** webm, which is what Chromium's MediaRecorder emits.
 * The client transcodes to wav for this provider only.
 */
export class OpenRouterSpeechToTextProvider implements SpeechToTextProvider {
  readonly id = 'openrouter' as const;

  readonly acceptedMimeTypes = [
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
    'audio/mpeg',
    'audio/ogg',
    'audio/flac',
    'audio/mp4',
    'audio/x-m4a',
  ] as const;

  constructor(private readonly apiKey: string) {}

  async transcribe(input: TranscribeAudioInput): Promise<string> {
    const instructions = [
      'Transcribe the audio verbatim.',
      'Reply with the transcript text and nothing else.',
      'Do not add commentary, quotation marks, or a preamble.',
      'If the audio contains no speech, reply with an empty string.',
    ];
    if (input.language) {
      instructions.push(`The audio is in ${input.language}.`);
    }
    if (input.keyterms.length > 0) {
      instructions.push(
        `These terms may appear; spell them exactly like this: ${input.keyterms
          .slice(0, MAX_KEYTERMS)
          .join(', ')}.`,
      );
    }

    const body = {
      model: input.model,
      // Deterministic: this is a transcription task, not a creative one.
      temperature: 0,
      messages: [
        { role: 'system', content: instructions.join(' ') },
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: input.audio.toString('base64'),
                format: audioFormatFor(input.mimeType),
              },
            },
          ],
        },
      ],
    };

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new SpeechToTextProviderError(
        `Could not reach OpenRouter: ${(error as Error).message}`,
      );
    }

    if (!response.ok) {
      throw new SpeechToTextProviderError(
        describeFailure(response.status),
        response.status,
      );
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new SpeechToTextProviderError(
        `${input.model} did not return a transcript. It may not accept audio input — pick an audio-capable model in Settings.`,
      );
    }

    return stripTranscriptPreamble(content);
  }
}

/** OpenRouter names formats by codec, not MIME type. */
function audioFormatFor(mimeType: string): string {
  switch (baseMimeType(mimeType)) {
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/flac':
      return 'flac';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'm4a';
    default:
      return 'wav';
  }
}

/**
 * Chat models like to answer rather than transcribe. Strip the conversational
 * wrapper they add so the textarea gets only the spoken words.
 */
export function stripTranscriptPreamble(input: string): string {
  let text = input.trim();

  // Fenced blocks: some models wrap the transcript in ``` or ```text.
  const fenced = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fenced) {
    text = fenced[1]!.trim();
  }

  // "Here is the transcription:", "Transcript:", "Sure, here's the transcript —"
  text = text.replace(
    /^(?:sure[,!]?\s*)?(?:here(?:'s| is)?\s+(?:the\s+)?)?(?:verbatim\s+)?transcript(?:ion)?(?:\s+of\s+the\s+audio)?\s*[:—-]\s*/i,
    '',
  );

  // A transcript quoted as a whole; leave inner quotes alone.
  const quoted = /^"([\s\S]*)"$/.exec(text) ?? /^'([\s\S]*)'$/.exec(text);
  if (quoted && !quoted[1]!.includes('"')) {
    text = quoted[1]!;
  }

  return text.trim();
}

/** Deliberately does not include the response body, which can echo the key. */
function describeFailure(status: number): string {
  if (status === 401 || status === 403) {
    return 'OpenRouter rejected the API key. Check it in Settings.';
  }
  if (status === 402) {
    return 'OpenRouter reports insufficient credit.';
  }
  if (status === 404) {
    return 'OpenRouter does not know that model id. Check it in Settings.';
  }
  if (status === 429) {
    return 'OpenRouter rate limit reached. Try again in a moment.';
  }
  return `OpenRouter returned HTTP ${status}.`;
}
