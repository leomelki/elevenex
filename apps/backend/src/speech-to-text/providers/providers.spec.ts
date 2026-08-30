import { ElevenLabsSpeechToTextProvider } from './elevenlabs.provider.js';
import { LocalWhisperSpeechToTextProvider } from './local-whisper.provider.js';
import { OpenAiCompatibleSpeechToTextProvider } from './openai-compatible.provider.js';
import {
  OpenRouterSpeechToTextProvider,
  stripTranscriptPreamble,
} from './openrouter.provider.js';
import {
  SpeechToTextProviderError,
  extensionForMimeType,
} from '../speech-to-text.types.js';

const AUDIO = Buffer.from('fake-audio-bytes');

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  json?: unknown;
}): jest.Mock {
  const fetchMock = jest.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.json ?? {},
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe('extensionForMimeType', () => {
  it.each([
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/mp4', 'm4a'],
    ['audio/wav', 'wav'],
    ['audio/mpeg', 'mp3'],
    ['application/octet-stream', 'bin'],
  ])('maps %s to .%s', (mimeType, expected) => {
    expect(extensionForMimeType(mimeType)).toBe(expected);
  });
});

describe('ElevenLabsSpeechToTextProvider', () => {
  it('posts the audio with the key header and returns the text', async () => {
    const fetchMock = mockFetch({ json: { text: '  hello world  ' } });
    const provider = new ElevenLabsSpeechToTextProvider('xi-key');

    const text = await provider.transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm;codecs=opus',
      model: 'scribe_v2',
      language: 'en',
      keyterms: ['cw-composer.component.ts'],
    });

    expect(text).toBe('hello world');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('xi-key');

    const form = init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('language_code')).toBe('en');
    expect(form.get('keyterms')).toBe('["cw-composer.component.ts"]');
    // The filename extension matters: providers sniff it as well as the type.
    expect((form.get('file') as File).name).toBe('dictation.webm');
  });

  it('omits keyterms and language when they are not set', async () => {
    const fetchMock = mockFetch({ json: { text: 'hi' } });
    const provider = new ElevenLabsSpeechToTextProvider('xi-key');

    await provider.transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      model: 'scribe_v2',
      language: null,
      languages: [],
      keyterms: [],
    });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .body as FormData;
    expect(form.has('keyterms')).toBe(false);
    expect(form.has('language_code')).toBe(false);
  });

  it('reports a bad key without leaking the response body', async () => {
    mockFetch({ ok: false, status: 401 });
    const provider = new ElevenLabsSpeechToTextProvider('xi-key');

    await expect(
      provider.transcribe({
        audio: AUDIO,
        mimeType: 'audio/webm',
        model: 'scribe_v2',
        language: null,
        languages: [],
        keyterms: [],
      }),
    ).rejects.toThrow(/rejected the API key/i);
  });
});

describe('OpenAiCompatibleSpeechToTextProvider', () => {
  it('posts to {baseUrl}/audio/transcriptions with a bearer token', async () => {
    const fetchMock = mockFetch({ json: { text: 'hello' } });
    const provider = new OpenAiCompatibleSpeechToTextProvider(
      'sk-key',
      'https://api.groq.com/openai/v1/',
    );

    await provider.transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm;codecs=opus',
      model: 'whisper-large-v3-turbo',
      language: null,
      languages: [],
      keyterms: ['useEffect', 'claude-composer'],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Trailing slash on the configured base URL must not double up.
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-key',
    );

    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('prompt')).toBe('useEffect, claude-composer');
  });

  it('explains a 404 as a wrong base URL', async () => {
    mockFetch({ ok: false, status: 404 });
    const provider = new OpenAiCompatibleSpeechToTextProvider(
      'sk-key',
      'https://example.test/v1',
    );

    await expect(
      provider.transcribe({
        audio: AUDIO,
        mimeType: 'audio/webm',
        model: 'whisper-1',
        language: null,
        languages: [],
        keyterms: [],
      }),
    ).rejects.toThrow(/base URL/i);
  });
});

describe('OpenRouterSpeechToTextProvider', () => {
  it('sends base64 audio as an input_audio chat part', async () => {
    const fetchMock = mockFetch({
      json: { choices: [{ message: { content: 'fix the composer' } }] },
    });
    const provider = new OpenRouterSpeechToTextProvider('or-key');

    const text = await provider.transcribe({
      audio: AUDIO,
      mimeType: 'audio/wav',
      model: 'google/gemini-2.5-flash',
      language: null,
      languages: [],
      keyterms: [],
    });

    expect(text).toBe('fix the composer');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('google/gemini-2.5-flash');
    expect(body.temperature).toBe(0);
    expect(body.messages[1].content[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: AUDIO.toString('base64'), format: 'wav' },
    });
  });

  it('does not accept webm, which is what MediaRecorder produces', () => {
    const provider = new OpenRouterSpeechToTextProvider('or-key');
    expect(provider.acceptedMimeTypes).not.toContain('audio/webm');
    expect(provider.acceptedMimeTypes).toContain('audio/wav');
  });

  it('explains when the chosen model returned no audio transcript', async () => {
    mockFetch({ json: { choices: [{ message: {} }] } });
    const provider = new OpenRouterSpeechToTextProvider('or-key');

    await expect(
      provider.transcribe({
        audio: AUDIO,
        mimeType: 'audio/wav',
        model: 'some/text-only-model',
        language: null,
        languages: [],
        keyterms: [],
      }),
    ).rejects.toThrow(SpeechToTextProviderError);
  });
});

describe('stripTranscriptPreamble', () => {
  it.each([
    ['Here is the transcription: fix the bug', 'fix the bug'],
    ["Sure, here's the transcript — fix the bug", 'fix the bug'],
    ['Transcript: fix the bug', 'fix the bug'],
    ['"fix the bug"', 'fix the bug'],
    ['```\nfix the bug\n```', 'fix the bug'],
    ['```text\nfix the bug\n```', 'fix the bug'],
    ['  fix the bug  ', 'fix the bug'],
  ])('strips %j', (input, expected) => {
    expect(stripTranscriptPreamble(input)).toBe(expected);
  });

  it('leaves a transcript that legitimately mentions transcripts alone', () => {
    expect(stripTranscriptPreamble('add a transcript view to the sidebar')).toBe(
      'add a transcript view to the sidebar',
    );
  });

  it('keeps inner quotes when only the outside is quoted', () => {
    expect(stripTranscriptPreamble('rename it to "foo" please')).toBe(
      'rename it to "foo" please',
    );
  });
});

describe('LocalWhisperSpeechToTextProvider', () => {
  /** 16 kHz mono 16-bit PCM, exactly what the client transcodes to. */
  function wav(sampleCount: number): Buffer {
    const dataBytes = sampleCount * 2;
    const buffer = Buffer.alloc(44 + dataBytes);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataBytes, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(16_000, 24);
    buffer.writeUInt32LE(32_000, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < sampleCount; i += 1) {
      buffer.writeInt16LE(i % 2 ? 8000 : -8000, 44 + i * 2);
    }
    return buffer;
  }

  const engine = () => ({ transcribe: jest.fn(async () => 'ship the fix') });

  it('accepts only WAV, which is what the client transcodes to', () => {
    const provider = new LocalWhisperSpeechToTextProvider(engine() as never);
    expect(provider.acceptedMimeTypes).toContain('audio/wav');
    expect(provider.acceptedMimeTypes).not.toContain('audio/webm');
  });

  it('decodes the container and passes samples plus every allowed language', async () => {
    const local = engine();
    const provider = new LocalWhisperSpeechToTextProvider(local as never);

    const text = await provider.transcribe({
      audio: wav(320),
      mimeType: 'audio/wav',
      // A cloud provider would get `language: null` here, since it can only be
      // pinned to one; this engine gets the whole set and detects among it.
      language: null,
      languages: ['fr', 'en'],
      model: 'small',
      keyterms: ['useAuthStore'],
    });

    expect(text).toBe('ship the fix');
    const call = local.transcribe.mock.calls[0]![0] as {
      samples: Float32Array;
      model: string;
      languages: string[];
    };
    expect(call.samples).toBeInstanceOf(Float32Array);
    expect(call.samples.length).toBe(320);
    expect(call.model).toBe('small');
    expect(call.languages).toEqual(['fr', 'en']);
    // Whisper has no keyterm input; passing one silently would be a lie.
    expect(call).not.toHaveProperty('keyterms');
  });

  it('reports a malformed container as a user-actionable error', async () => {
    const provider = new LocalWhisperSpeechToTextProvider(engine() as never);

    await expect(
      provider.transcribe({
        audio: Buffer.from('this is definitely not a wav file'),
        mimeType: 'audio/wav',
        model: 'small',
        language: null,
        languages: [],
        keyterms: [],
      }),
    ).rejects.toBeInstanceOf(SpeechToTextProviderError);
  });

  it('rejects a container holding no samples rather than calling the engine', async () => {
    const local = engine();
    const provider = new LocalWhisperSpeechToTextProvider(local as never);

    await expect(
      provider.transcribe({
        audio: wav(0),
        mimeType: 'audio/wav',
        model: 'small',
        language: null,
        languages: [],
        keyterms: [],
      }),
    ).rejects.toThrow(SpeechToTextProviderError);
    expect(local.transcribe).not.toHaveBeenCalled();
  });
});
