import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalWhisperService } from './local-whisper.service.js';

/**
 * Every test works against a throwaway cache directory rather than the
 * developer's real one — these tests delete models.
 */
let cacheDir: string;

const settingsStub = (localModel = 'small') => ({
  getSpeechToTextConfig: jest.fn(async () => ({ localModel })),
});

type Service = InstanceType<typeof LocalWhisperService>;

async function markDownloaded(repo: string): Promise<void> {
  const dir = join(cacheDir, ...repo.split('/'));
  await mkdir(join(dir, 'onnx'), { recursive: true });
  await writeFile(join(dir, 'onnx', 'encoder_model_quantized.onnx'), 'x');
  await writeFile(join(dir, 'onnx', 'decoder_model_merged_quantized.onnx'), 'x');
  await writeFile(join(dir, '.elevenex-complete'), repo);
}

describe('LocalWhisperService', () => {
  let service: Service;

  beforeAll(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'elevenex-whisper-'));
    // Read per instance, so setting it here is enough — the services are
    // constructed in `beforeEach`.
    process.env.ELEVENEX_WHISPER_CACHE_DIR = cacheDir;
  });

  afterAll(async () => {
    delete process.env.ELEVENEX_WHISPER_CACHE_DIR;
    await rm(cacheDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    service = new LocalWhisperService(settingsStub() as never);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    await rm(join(cacheDir, 'onnx-community'), {
      recursive: true,
      force: true,
    });
  });

  it('reports the catalog with nothing downloaded on a fresh machine', async () => {
    const status = await service.getStatus();

    expect(status.cacheDir).toBe(cacheDir);
    expect(status.selectedModel).toBe('small');
    expect(status.models.map((model) => model.id)).toEqual([
      'tiny',
      'base',
      'small',
      'large-v3-turbo',
    ]);
    expect(
      status.models.every((model) => model.status === 'not-downloaded'),
    ).toBe(true);
    expect(status.models.every((model) => model.downloadBytes > 0)).toBe(true);
  });

  it('treats weights without the completion marker as not downloaded', async () => {
    // What an interrupted download leaves behind: a plausible-looking pair of
    // .onnx files that may still be half-written.
    const dir = join(cacheDir, 'onnx-community', 'whisper-small', 'onnx');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'encoder_model_quantized.onnx'), 'partial');

    expect(await service.isReady('small')).toBe(false);
  });

  it('reports a marked model as ready', async () => {
    await markDownloaded('onnx-community/whisper-small');

    expect(await service.isReady('small')).toBe(true);
    const status = await service.getStatus();
    expect(
      status.models.find((model) => model.id === 'small')?.status,
    ).toBe('ready');
  });

  it('refuses to transcribe with a model that is not downloaded', async () => {
    await expect(
      service.transcribe({
        samples: new Float32Array(16_000),
        model: 'base',
        languages: [],
      }),
    ).rejects.toThrow(/not downloaded/i);
  });

  it('joins a second download of the same model to the running one', () => {
    const first = service.download('tiny');
    const second = service.download('tiny');

    // Two transfers of the same 45 MB would be pure waste, and the second
    // would race the first's writes.
    expect(second).toBe(first);
  });

  it('rejects a model id that is not in the catalog', () => {
    expect(() => service.download('enormous' as never)).toThrow(/Unknown/i);
  });

  it('deletes a downloaded model and forgets it is ready', async () => {
    await markDownloaded('onnx-community/whisper-small');
    expect(await service.isReady('small')).toBe(true);

    await service.remove('small');

    expect(await service.isReady('small')).toBe(false);
    const status = await service.getStatus();
    expect(
      status.models.find((model) => model.id === 'small')?.status,
    ).toBe('not-downloaded');
  });

  it('reports a download in progress with its own progress figures', async () => {
    const job = service.download('tiny');
    // Stand in for the transfer without touching the network.
    job.loadedByFile.set('onnx/encoder_model_quantized.onnx', 4_500_000);
    job.currentFile = 'onnx/encoder_model_quantized.onnx';

    const status = await service.getStatus();
    const tiny = status.models.find((model) => model.id === 'tiny');

    expect(tiny?.status).toBe('downloading');
    expect(tiny?.loadedBytes).toBe(4_500_000);
    expect(tiny?.progress).toBeGreaterThan(0);
    expect(tiny?.progress).toBeLessThan(1);
    expect(tiny?.currentFile).toBe('onnx/encoder_model_quantized.onnx');

    await service.cancelDownload('tiny');
  });

  describe('pipeline serialization', () => {
    /**
     * Stands in for a loaded pipeline, recording whether it was disposed while
     * an inference was still running — the failure mode these guard.
     */
    function fakePipeline() {
      const state = { disposed: false, disposedDuringRun: false, running: false };
      const transcriber = async () => {
        state.running = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        state.running = false;
        return { text: 'hello' };
      };
      (transcriber as unknown as { dispose: () => void }).dispose = () => {
        if (state.running) {
          state.disposedDuringRun = true;
        }
        state.disposed = true;
      };
      return { state, transcriber };
    }

    function install(target: Service, pipeline: ReturnType<typeof fakePipeline>) {
      const internals = target as unknown as {
        loadedModel: string;
        pipelinePromise: Promise<unknown>;
      };
      internals.loadedModel = 'small';
      internals.pipelinePromise = Promise.resolve(pipeline.transcriber);
    }

    it('does not release the weights a dictation is still using', async () => {
      await markDownloaded('onnx-community/whisper-small');
      const pipeline = fakePipeline();
      install(service, pipeline);

      const speaking = service.transcribe({
        samples: new Float32Array(16_000),
        model: 'small',
        languages: [],
      });
      // Deleting the resident model is a real entry point that evicts. Before
      // the queue it disposed immediately, pulling the weights out from under
      // the transcription that was mid-flight.
      const deleting = service.remove('small');

      await Promise.all([speaking, deleting]);

      expect(pipeline.state.disposed).toBe(true);
      expect(pipeline.state.disposedDuringRun).toBe(false);
    });

    it('runs dictations one at a time rather than thrashing the CPU', async () => {
      await markDownloaded('onnx-community/whisper-small');
      let concurrent = 0;
      let peak = 0;

      const internals = service as unknown as {
        loadedModel: string;
        pipelinePromise: Promise<unknown>;
      };
      internals.loadedModel = 'small';
      internals.pipelinePromise = Promise.resolve(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
        return { text: 'hi' };
      });

      await Promise.all([
        service.transcribe({ samples: new Float32Array(16_000), model: 'small', languages: [] }),
        service.transcribe({ samples: new Float32Array(16_000), model: 'small', languages: [] }),
        service.transcribe({ samples: new Float32Array(16_000), model: 'small', languages: [] }),
      ]);

      expect(peak).toBe(1);
    });

    it('keeps serving later dictations after one fails', async () => {
      await markDownloaded('onnx-community/whisper-small');
      let call = 0;

      const internals = service as unknown as {
        loadedModel: string;
        pipelinePromise: Promise<unknown>;
      };
      internals.loadedModel = 'small';
      internals.pipelinePromise = Promise.resolve(async () => {
        call += 1;
        if (call === 1) {
          throw new Error('inference blew up');
        }
        return { text: 'second' };
      });

      await expect(
        service.transcribe({ samples: new Float32Array(16_000), model: 'small', languages: [] }),
      ).rejects.toThrow(/blew up/);

      // A rejected task must not poison the shared queue.
      await expect(
        service.transcribe({ samples: new Float32Array(16_000), model: 'small', languages: [] }),
      ).resolves.toBe('second');
    });
  });

  describe('language selection', () => {
    /**
     * Whisper's language table, cut down to what these tests need. The real one
     * carries all ninety-nine; the ids are arbitrary but must be distinct.
     */
    const LANG_TO_ID = {
      '<|en|>': 50259,
      '<|fr|>': 50265,
      '<|de|>': 50261,
      '<|ja|>': 50266,
    };
    const START_TOKEN = 50258;

    /**
     * A pipeline that records the options it is asked to transcribe with, and
     * answers the one-token detection pass with `detected`.
     */
    function fakePipeline(detected: keyof typeof LANG_TO_ID | 'none') {
      const transcribeOptions: Record<string, unknown>[] = [];
      const generateOptions: Record<string, unknown>[] = [];

      const transcriber = Object.assign(
        async (_audio: Float32Array, options: Record<string, unknown>) => {
          transcribeOptions.push(options);
          return { text: 'bonjour' };
        },
        {
          processor: async (samples: Float32Array) => ({
            input_features: { samples: samples.length },
          }),
          model: {
            generation_config: {
              decoder_start_token_id: START_TOKEN,
              lang_to_id: LANG_TO_ID,
              suppress_tokens: [1, 2],
            },
            generate: async (options: Record<string, unknown>) => {
              generateOptions.push(options);
              const token = detected === 'none' ? 9_999 : LANG_TO_ID[detected];
              // Shaped like a real generate() result: the prompt token followed
              // by what the model produced, as BigInt from the int64 tensor.
              return {
                tolist: () => [[BigInt(START_TOKEN), BigInt(token)]],
              };
            },
          },
        },
      );

      return { transcriber, transcribeOptions, generateOptions };
    }

    async function install(pipeline: { transcriber: unknown }) {
      await markDownloaded('onnx-community/whisper-small');
      const internals = service as unknown as {
        loadedModel: string;
        pipelinePromise: Promise<unknown>;
      };
      internals.loadedModel = 'small';
      internals.pipelinePromise = Promise.resolve(pipeline.transcriber);
    }

    it('pins a single language without paying for a detection pass', async () => {
      const pipeline = fakePipeline('<|en|>');
      await install(pipeline);

      await service.transcribe({
        samples: new Float32Array(16_000),
        model: 'small',
        languages: ['fr'],
      });

      // The whole point of one-language setups: no extra encoder run.
      expect(pipeline.generateOptions).toHaveLength(0);
      expect(pipeline.transcribeOptions[0]?.language).toBe('fr');
    });

    it('detects among the allowed languages and transcribes with the winner', async () => {
      const pipeline = fakePipeline('<|en|>');
      await install(pipeline);

      await service.transcribe({
        samples: new Float32Array(16_000),
        model: 'small',
        languages: ['fr', 'en'],
      });

      expect(pipeline.generateOptions).toHaveLength(1);
      expect(pipeline.transcribeOptions[0]?.language).toBe('en');
    });

    it('suppresses the languages the user did not allow', async () => {
      const pipeline = fakePipeline('<|fr|>');
      await install(pipeline);

      await service.transcribe({
        samples: new Float32Array(16_000),
        model: 'small',
        languages: ['fr', 'en'],
      });

      const suppressed = pipeline.generateOptions[0]?.suppress_tokens as number[];
      // Narrowing the field to the two candidates is what makes detection
      // reliable on the small builds.
      expect(suppressed).toEqual(expect.arrayContaining([50261, 50266]));
      expect(suppressed).not.toContain(50259);
      expect(suppressed).not.toContain(50265);
      // The model's own suppression list has to survive, not be replaced.
      expect(suppressed).toEqual(expect.arrayContaining([1, 2]));
      // Only the start token is prompted, so the model must predict the rest.
      expect(pipeline.generateOptions[0]?.decoder_input_ids).toEqual([
        START_TOKEN,
      ]);
    });

    it('detects freely when no language is restricted', async () => {
      const pipeline = fakePipeline('<|ja|>');
      await install(pipeline);

      await service.transcribe({
        samples: new Float32Array(16_000),
        model: 'small',
        languages: [],
      });

      // Transformers.js has no detection of its own and would have forced
      // English here, which is the bug this pass exists to fix.
      expect(pipeline.generateOptions[0]?.suppress_tokens).toEqual([1, 2]);
      expect(pipeline.transcribeOptions[0]?.language).toBe('ja');
    });

    it('falls back to the first choice when detection answers with a non-language', async () => {
      const pipeline = fakePipeline('none');
      await install(pipeline);

      await service.transcribe({
        samples: new Float32Array(16_000),
        model: 'small',
        languages: ['fr', 'en'],
      });

      expect(pipeline.transcribeOptions[0]?.language).toBe('fr');
    });

    it('still transcribes when the detection pass throws', async () => {
      const pipeline = fakePipeline('<|en|>');
      pipeline.transcriber.model.generate = async () => {
        throw new Error('onnx session died');
      };
      await install(pipeline);

      await expect(
        service.transcribe({
          samples: new Float32Array(16_000),
          model: 'small',
          languages: ['fr', 'en'],
        }),
      ).resolves.toBe('bonjour');
      expect(pipeline.transcribeOptions[0]?.language).toBe('fr');
    });

    it('only feeds detection one window, however long the recording is', async () => {
      const pipeline = fakePipeline('<|en|>');
      await install(pipeline);

      await service.transcribe({
        // Two minutes: chunked for transcription, but the language token is
        // decided once, so detection must not encode all of it.
        samples: new Float32Array(120 * 16_000),
        model: 'small',
        languages: ['fr', 'en'],
      });

      const features = pipeline.generateOptions[0]?.inputs as {
        samples: number;
      };
      expect(features.samples).toBe(30 * 16_000);
    });
  });

  it('will not delete a model out from under a running download', async () => {
    service.download('tiny');

    await expect(service.remove('tiny')).rejects.toThrow(/still downloading/i);

    await service.cancelDownload('tiny');
  });
});
