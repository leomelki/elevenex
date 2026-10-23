import fs, { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalWhisperService } from './local-whisper.service.js';

/**
 * Every test works against a throwaway cache directory rather than the
 * developer's real one — these tests delete models.
 */
let cacheDir: string;
const originalFetch = global.fetch;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function nativePipeline(run = async () => ({ text: 'hello' })) {
  return Object.assign(jest.fn(run), {
    dispose: jest.fn(async () => undefined),
  });
}

type Internals = {
  loadedModel: string | null;
  pipelinePromise: Promise<unknown> | null;
  createPipeline: (spec: unknown) => Promise<ReturnType<typeof nativePipeline>>;
  fetchFile: (...args: unknown[]) => Promise<void>;
  hasCompleteDownload: (...args: unknown[]) => Promise<boolean>;
  evictTimer: NodeJS.Timeout | null;
};

const settingsStub = (localModel = 'small') => ({
  getSpeechToTextConfig: jest.fn(async () => ({ localModel })),
});

type Service = InstanceType<typeof LocalWhisperService>;

async function markDownloaded(repo: string): Promise<void> {
  const dir = join(cacheDir, ...repo.split('/'));
  await mkdir(join(dir, 'onnx'), { recursive: true });
  await writeFile(join(dir, 'onnx', 'encoder_model_quantized.onnx'), 'x');
  await writeFile(
    join(dir, 'onnx', 'decoder_model_merged_quantized.onnx'),
    'x',
  );
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
    // Transfers are controlled by each test; never fetch real model weights.
    global.fetch = jest.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init!.signal!;
          if (signal.aborted) return reject(new Error('aborted'));
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    ) as never;
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    await rm(join(cacheDir, 'onnx-community'), {
      recursive: true,
      force: true,
    });
  });

  describe('lifecycle ownership', () => {
    const audio = () => ({
      samples: new Float32Array(160),
      model: 'small' as const,
      languages: ['en'],
    });
    const internals = () => service as unknown as Internals;

    async function install(pipeline: ReturnType<typeof nativePipeline>) {
      await markDownloaded('onnx-community/whisper-small');
      internals().loadedModel = 'small';
      internals().pipelinePromise = Promise.resolve(pipeline);
    }

    it('reports a failed native load and clears the error after a successful retry', async () => {
      await markDownloaded('onnx-community/whisper-small');
      jest
        .spyOn(internals(), 'createPipeline')
        .mockRejectedValueOnce(new Error('native load failed'))
        .mockResolvedValueOnce(nativePipeline());
      await expect(service.transcribe(audio())).rejects.toThrow(
        'native load failed',
      );
      expect(
        (await service.getStatus()).models.find(
          (model) => model.id === 'small',
        ),
      ).toMatchObject({
        status: 'error',
        error: 'native load failed',
        loadedInMemory: false,
      });
      await expect(service.transcribe(audio())).resolves.toBe('hello');
      expect(
        (await service.getStatus()).models.find(
          (model) => model.id === 'small',
        ),
      ).toMatchObject({
        status: 'ready',
        error: null,
        loadedInMemory: true,
      });
    });

    it('preserves the model files and reports an error if native disposal fails', async () => {
      await markDownloaded('onnx-community/whisper-small');
      const pipeline = nativePipeline();
      const replacement = nativePipeline();
      jest
        .spyOn(internals(), 'createPipeline')
        .mockResolvedValueOnce(pipeline)
        .mockResolvedValue(replacement);
      await service.transcribe(audio());
      pipeline.dispose.mockRejectedValueOnce(
        new Error('native disposal failed'),
      );
      await expect(service.remove('small')).rejects.toThrow(
        'native disposal failed',
      );
      await expect(
        stat(
          join(
            cacheDir,
            'onnx-community',
            'whisper-small',
            '.elevenex-complete',
          ),
        ),
      ).resolves.toBeDefined();
      expect(
        (await service.getStatus()).models.find(
          (model) => model.id === 'small',
        ),
      ).toMatchObject({
        status: 'error',
        error: 'native disposal failed',
        loadedInMemory: true,
      });
      await expect(service.transcribe(audio())).resolves.toBe('hello');
      expect(pipeline.dispose).toHaveBeenCalledTimes(2);
      expect(pipeline).toHaveBeenCalledTimes(1);
      expect(replacement).toHaveBeenCalledTimes(1);
    });

    it('cancels a late download response during shutdown without reading or writing it', async () => {
      const entered = deferred();
      const transfer = deferred<Response>();
      const cancel = jest.fn(async () => undefined);
      const create = jest.spyOn(internals(), 'createPipeline');
      global.fetch = jest.fn(() => {
        entered.resolve();
        return transfer.promise;
      }) as never;
      const job = service.download('tiny');
      await entered.promise;
      const shutdown = service.onModuleDestroy();
      expect(job.controller.signal.aborted).toBe(true);
      transfer.resolve({
        ok: true,
        status: 200,
        body: { cancel },
      } as unknown as Response);
      await shutdown;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      await expect(
        stat(
          join(
            cacheDir,
            'onnx-community',
            'whisper-tiny',
            'onnx',
            'encoder_model_quantized.onnx',
          ),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('removes a completion marker whose write settles after shutdown starts', async () => {
      jest.spyOn(internals(), 'fetchFile').mockResolvedValue(undefined);
      const pipeline = nativePipeline();
      jest.spyOn(internals(), 'createPipeline').mockResolvedValue(pipeline);
      const marker = join(
        cacheDir,
        'onnx-community',
        'whisper-tiny',
        '.elevenex-complete',
      );
      const entered = deferred();
      const writing = deferred();
      const originalWrite = fs.writeFile;
      jest
        .spyOn(fs, 'writeFile')
        .mockImplementation(async (file, data, options) => {
          if (file === marker) {
            entered.resolve();
            await writing.promise;
          }
          return originalWrite(file, data, options);
        });
      service.download('tiny');
      await entered.promise;
      const shutdown = service.onModuleDestroy();
      writing.resolve();
      await shutdown;
      expect(pipeline.dispose).toHaveBeenCalledTimes(1);
      expect(
        (await service.getStatus()).models.find((model) => model.id === 'tiny')
          ?.status,
      ).toBe('not-downloaded');
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('drains active inference before shutdown disposal and rejects queued/new work', async () => {
      const entered = deferred();
      const inference = deferred<{ text: string }>();
      const pipeline = nativePipeline(() => {
        entered.resolve();
        return inference.promise;
      });
      await install(pipeline);
      const speaking = service.transcribe(audio());
      await entered.promise;
      const queued = service.transcribe(audio());
      const queuedFailure = expect(queued).rejects.toThrow(/shutting down/i);
      const shutdown = service.onModuleDestroy();
      expect(service.onModuleDestroy()).toBe(shutdown);
      await Promise.resolve();
      expect(pipeline.dispose).not.toHaveBeenCalled();
      await expect(service.transcribe(audio())).rejects.toThrow(
        /shutting down/i,
      );
      expect(() => service.download('tiny')).toThrow(/shutting down/i);
      await expect(service.remove('small')).rejects.toThrow(/shutting down/i);
      inference.resolve({ text: 'finished' });
      await expect(speaking).resolves.toBe('finished');
      await queuedFailure;
      await shutdown;
      expect(pipeline).toHaveBeenCalledTimes(1);
      expect(pipeline.dispose).toHaveBeenCalledTimes(1);
      expect(internals().pipelinePromise).toBeNull();
      expect(internals().evictTimer).toBeNull();
    });

    it('drains a native load on shutdown without starting inference or another load', async () => {
      await markDownloaded('onnx-community/whisper-small');
      const entered = deferred();
      const loading = deferred<ReturnType<typeof nativePipeline>>();
      const create = jest
        .spyOn(internals(), 'createPipeline')
        .mockImplementation(() => {
          entered.resolve();
          return loading.promise;
        });
      const speaking = service.transcribe(audio());
      const failed = expect(speaking).rejects.toThrow(/shutting down/i);
      await entered.promise;
      expect(
        (await service.getStatus()).models.find((model) => model.id === 'small')
          ?.loadedInMemory,
      ).toBe(false);
      const queued = expect(service.transcribe(audio())).rejects.toThrow(
        /shutting down/i,
      );
      const shutdown = service.onModuleDestroy();
      const pipeline = nativePipeline();
      expect(pipeline.dispose).not.toHaveBeenCalled();
      loading.resolve(pipeline);
      await Promise.all([failed, queued, shutdown]);
      expect(create).toHaveBeenCalledTimes(1);
      expect(pipeline).not.toHaveBeenCalled();
      expect(pipeline.dispose).toHaveBeenCalledTimes(1);
    });

    it('holds the queue and disk reservation through deletion and cache invalidation', async () => {
      const pipeline = nativePipeline();
      await install(pipeline);
      expect(await service.isReady('small')).toBe(true);
      const entered = deferred();
      const deleting = deferred();
      const originalRm = fs.rm;
      const modelDir = join(cacheDir, 'onnx-community', 'whisper-small');
      jest.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
        if (path === modelDir) {
          entered.resolve();
          await deleting.promise;
        }
        return originalRm(path, options);
      });
      const create = jest.spyOn(internals(), 'createPipeline');
      const removal = service.remove('small');
      await entered.promise;
      expect(pipeline.dispose).toHaveBeenCalledTimes(1);
      const speaking = service.transcribe(audio());
      const failed = expect(speaking).rejects.toThrow(/not downloaded/i);
      expect(() => service.download('small')).toThrow(/being removed/i);
      await Promise.resolve();
      expect(create).not.toHaveBeenCalled();
      deleting.resolve();
      await Promise.all([removal, failed]);
      expect(create).not.toHaveBeenCalled();
      expect(await service.isReady('small')).toBe(false);
      await expect(stat(modelDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('checks the resident model when removal executes, after a pending load', async () => {
      await markDownloaded('onnx-community/whisper-small');
      const entered = deferred();
      const loading = deferred<ReturnType<typeof nativePipeline>>();
      jest.spyOn(internals(), 'createPipeline').mockImplementation(() => {
        entered.resolve();
        return loading.promise;
      });
      const speaking = service.transcribe(audio());
      await entered.promise;
      const removal = service.remove('small');
      const pipeline = nativePipeline();
      loading.resolve(pipeline);
      await Promise.all([speaking, removal]);
      expect(pipeline.dispose).toHaveBeenCalledTimes(1);
      expect(internals().pipelinePromise).toBeNull();
      expect(await service.isReady('small')).toBe(false);
    });

    it('does not let a stale status scan restore readiness after removal', async () => {
      const scan = deferred<boolean>();
      jest
        .spyOn(internals(), 'hasCompleteDownload')
        .mockReturnValueOnce(scan.promise);
      const readiness = service.isReady('small');
      await service.remove('small');
      scan.resolve(true);
      expect(await readiness).toBe(false);
      expect(await service.isReady('small')).toBe(false);
    });

    it('does not publish readiness or load after a transfer completes during shutdown', async () => {
      const entered = deferred();
      const transfer = deferred();
      jest.spyOn(internals(), 'fetchFile').mockImplementation(() => {
        entered.resolve();
        return transfer.promise;
      });
      const create = jest.spyOn(internals(), 'createPipeline');
      const next = jest.fn();
      const complete = jest.fn();
      service.changes.subscribe({ next, complete });
      const job = service.download('tiny');
      await entered.promise;
      const shutdown = service.onModuleDestroy();
      const eventsAtShutdown = next.mock.calls.length;
      expect(job.controller.signal.aborted).toBe(true);
      transfer.resolve();
      await shutdown;
      expect(create).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(eventsAtShutdown);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(
        (await service.getStatus()).models.find((model) => model.id === 'tiny')
          ?.status,
      ).toBe('not-downloaded');
      await expect(
        stat(
          join(
            cacheDir,
            'onnx-community',
            'whisper-tiny',
            '.elevenex-complete',
          ),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each(['cancel', 'shutdown'])(
      'disposes a download validation load that completes after %s without marking it ready',
      async (action) => {
        jest.spyOn(internals(), 'fetchFile').mockResolvedValue(undefined);
        const entered = deferred();
        const loading = deferred<ReturnType<typeof nativePipeline>>();
        jest.spyOn(internals(), 'createPipeline').mockImplementation(() => {
          entered.resolve();
          return loading.promise;
        });
        const job = service.download('tiny');
        await entered.promise;
        const finishing =
          action === 'cancel'
            ? service.cancelDownload('tiny')
            : service.onModuleDestroy();
        const pipeline = nativePipeline();
        expect(pipeline.dispose).not.toHaveBeenCalled();
        loading.resolve(pipeline);
        await finishing;
        await job.promise;
        expect(pipeline.dispose).toHaveBeenCalledTimes(1);
        expect(internals().pipelinePromise).toBeNull();
        const tiny = (await service.getStatus()).models.find(
          (model) => model.id === 'tiny',
        );
        expect(tiny?.status).toBe('not-downloaded');
        expect(tiny?.error).toBeNull();
        expect(tiny?.loadedInMemory).toBe(false);
        await expect(
          stat(
            join(
              cacheDir,
              'onnx-community',
              'whisper-tiny',
              '.elevenex-complete',
            ),
          ),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );

    it('does not retain a load error from validation cancelled during shutdown', async () => {
      jest.spyOn(internals(), 'fetchFile').mockResolvedValue(undefined);
      const entered = deferred();
      const loading = deferred<ReturnType<typeof nativePipeline>>();
      jest.spyOn(internals(), 'createPipeline').mockImplementation(() => {
        entered.resolve();
        return loading.promise;
      });
      service.download('tiny');
      await entered.promise;
      const shutdown = service.onModuleDestroy();
      loading.reject(new Error('native load interrupted'));
      await shutdown;
      expect(
        (await service.getStatus()).models.find((model) => model.id === 'tiny'),
      ).toMatchObject({
        status: 'not-downloaded',
        error: null,
        loadedInMemory: false,
      });
    });

    it('cancels validation queued behind inference and prevents a replacement download during deletion', async () => {
      const entered = deferred();
      const inference = deferred<{ text: string }>();
      await install(
        nativePipeline(() => {
          entered.resolve();
          return inference.promise;
        }),
      );
      const speaking = service.transcribe(audio());
      await entered.promise;
      jest.spyOn(internals(), 'fetchFile').mockResolvedValue(undefined);
      const create = jest.spyOn(internals(), 'createPipeline');
      const job = service.download('tiny');
      // Let all transfer continuations queue their validation behind inference.
      await new Promise((resolve) => setImmediate(resolve));
      const cancelling = service.cancelDownload('tiny');
      expect(() => service.download('tiny')).toThrow(/being removed/i);
      inference.resolve({ text: 'finished' });
      await Promise.all([speaking, cancelling, job.promise]);
      expect(create).not.toHaveBeenCalled();
      expect(await service.isReady('tiny')).toBe(false);
    });

    it('skips a queued transcription cancelled by its client', async () => {
      const entered = deferred();
      const inference = deferred<{ text: string }>();
      const pipeline = nativePipeline(() => {
        entered.resolve();
        return inference.promise;
      });
      await install(pipeline);
      const speaking = service.transcribe(audio());
      await entered.promise;
      const client = new AbortController();
      const queued = service.transcribe({ ...audio(), signal: client.signal });
      const failed = expect(queued).rejects.toMatchObject({ status: 499 });
      client.abort();
      inference.resolve({ text: 'finished' });
      await Promise.all([speaking, failed]);
      expect(pipeline).toHaveBeenCalledTimes(1);
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
    expect(status.models.find((model) => model.id === 'small')?.status).toBe(
      'ready',
    );
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
    expect(status.models.find((model) => model.id === 'small')?.status).toBe(
      'not-downloaded',
    );
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
      const state = {
        disposed: false,
        disposedDuringRun: false,
        running: false,
      };
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

    function install(
      target: Service,
      pipeline: ReturnType<typeof fakePipeline>,
    ) {
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
        service.transcribe({
          samples: new Float32Array(16_000),
          model: 'small',
          languages: [],
        }),
        service.transcribe({
          samples: new Float32Array(16_000),
          model: 'small',
          languages: [],
        }),
        service.transcribe({
          samples: new Float32Array(16_000),
          model: 'small',
          languages: [],
        }),
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
        service.transcribe({
          samples: new Float32Array(16_000),
          model: 'small',
          languages: [],
        }),
      ).rejects.toThrow(/blew up/);

      // A rejected task must not poison the shared queue.
      await expect(
        service.transcribe({
          samples: new Float32Array(16_000),
          model: 'small',
          languages: [],
        }),
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

      const suppressed = pipeline.generateOptions[0]
        ?.suppress_tokens as number[];
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
