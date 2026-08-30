import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Subject } from 'rxjs';
import { SettingsService } from '../../settings/settings.service.js';
import type { LocalWhisperModelId } from '../../settings/settings.types.js';
import { SpeechToTextProviderError } from '../speech-to-text.types.js';
import type {
  LocalWhisperModelState,
  LocalWhisperStatus,
  LocalWhisperTranscribeInput,
} from './local-whisper.types.js';
import {
  LOCAL_WHISPER_CATALOG,
  WHISPER_ONNX_FILES,
  WHISPER_SUPPORT_FILES,
  findWhisperModel,
  type LocalWhisperModelSpec,
} from './whisper-catalog.js';
import { describeUnsupportedPlatform } from './whisper-platform.js';

/**
 * Weights live under the user's home rather than inside the app bundle so they
 * survive an update and can be deleted without reinstalling. The override
 * exists for machines whose home directory is on a small or network volume —
 * these models run to a gigabyte.
 *
 * Resolved per instance rather than at module load so the environment can be
 * set up before the service is constructed.
 */
function resolveCacheDir(): string {
  return (
    process.env.ELEVENEX_WHISPER_CACHE_DIR?.trim() ||
    join(homedir(), '.elevenex', 'whisper-models')
  );
}

/**
 * Written into a model's directory once its weights are on disk *and* a
 * pipeline has actually loaded from them. Presence of the .onnx files alone is
 * not enough — an interrupted download can leave a complete encoder and no
 * decoder, which would only fail at the moment the user tries to dictate.
 */
const COMPLETE_MARKER = '.elevenex-complete';

/**
 * Where weights are fetched from. `HF_ENDPOINT` is the variable the Hugging
 * Face tooling already uses, so a machine behind a mirror — common on the
 * locked-down hosts people attach as remote backends — needs no new setting.
 */
function resolveHfEndpoint(): string {
  const configured = process.env.HF_ENDPOINT?.trim();
  return (configured || 'https://huggingface.co').replace(/\/+$/, '');
}

/** Progress updates are coalesced to this cadence before hitting the SSE stream. */
const PROGRESS_EMIT_INTERVAL_MS = 300;

/**
 * How long a loaded pipeline is kept resident. Whisper Small holds ~250 MB, so
 * a long-idle session should give it back; a dictating user re-uses it and
 * never pays the load cost twice.
 */
const PIPELINE_IDLE_EVICT_MS = 10 * 60 * 1000;

interface DownloadJob {
  promise: Promise<void>;
  controller: AbortController;
  /** Per-file byte counts, so restarting a file cannot double-count progress. */
  loadedByFile: Map<string, number>;
  currentFile: string | null;
  cancelled: boolean;
}

/** The narrow slice of Transformers.js this service uses. */
interface WhisperPipeline {
  (
    audio: Float32Array,
    options: Record<string, unknown>,
  ): Promise<{ text?: unknown }>;
  dispose?: () => Promise<void> | void;
}

@Injectable()
export class LocalWhisperService implements OnModuleDestroy {
  private readonly logger = new Logger(LocalWhisperService.name);

  private readonly downloads = new Map<LocalWhisperModelId, DownloadJob>();
  private readonly errors = new Map<LocalWhisperModelId, string>();
  /** Cached readiness, so status polls do not stat the disk on every request. */
  private readonly readyCache = new Map<LocalWhisperModelId, boolean>();

  private loadedModel: LocalWhisperModelId | null = null;
  private pipelinePromise: Promise<WhisperPipeline> | null = null;
  private evictTimer: NodeJS.Timeout | null = null;

  /**
   * Serializes everything that touches the resident pipeline — inference, the
   * post-download validation load, and idle eviction.
   *
   * Two concurrent inferences would only thrash the CPU, but the dangerous
   * pair is a *load* racing an inference: loading a different model disposes
   * the current one, and a download finishing while the user dictates would
   * pull the weights out from under a running transcription.
   */
  private pipelineQueue: Promise<unknown> = Promise.resolve();

  /**
   * Set at construction on a machine ONNX Runtime has no build for, and
   * afterwards by a failed load. Non-null means every entry point below
   * refuses early with a message the user can act on.
   */
  private engineError: string | null = describeUnsupportedPlatform();
  private transformersPromise: Promise<TransformersModule> | null = null;

  private readonly changesSubject = new Subject<LocalWhisperStatus>();
  /** Status snapshots for the settings page's SSE stream. */
  readonly changes = this.changesSubject.asObservable();

  private lastEmitAt = 0;

  /** Where weights are stored. Fixed for the life of the service. */
  readonly cacheDir = resolveCacheDir();

  constructor(private readonly settingsService: SettingsService) {}

  async onModuleDestroy(): Promise<void> {
    for (const job of this.downloads.values()) {
      job.cancelled = true;
      job.controller.abort();
    }
    this.downloads.clear();
    await this.evictPipeline();
    this.changesSubject.complete();
  }

  async getStatus(): Promise<LocalWhisperStatus> {
    const settings = await this.settingsService.getSpeechToTextConfig();
    const models = await Promise.all(
      LOCAL_WHISPER_CATALOG.map((spec) => this.describe(spec)),
    );

    return {
      engineAvailable: this.engineError === null,
      engineError: this.engineError,
      cacheDir: this.cacheDir,
      selectedModel: settings.localModel,
      models,
    };
  }

  /** True when dictation could run right now without downloading anything. */
  async isReady(model: LocalWhisperModelId): Promise<boolean> {
    const cached = this.readyCache.get(model);
    if (cached !== undefined) {
      return cached;
    }

    const spec = findWhisperModel(model);
    if (!spec) {
      return false;
    }

    const ready = await this.hasCompleteDownload(spec);
    this.readyCache.set(model, ready);
    return ready;
  }

  /**
   * Fetches the weights, then loads them once to prove they work.
   *
   * Detached from the request that starts it: downloads run for minutes and
   * closing the settings page must not cancel one. Concurrent calls for the
   * same model join the in-flight job rather than starting a second transfer.
   */
  download(model: LocalWhisperModelId): DownloadJob {
    const existing = this.downloads.get(model);
    if (existing) {
      return existing;
    }

    const spec = findWhisperModel(model);
    if (!spec) {
      throw new SpeechToTextProviderError(`Unknown Whisper model: ${model}.`);
    }

    // Refuse before spending a gigabyte of the user's bandwidth on weights this
    // machine could never load.
    const unsupported = describeUnsupportedPlatform();
    if (unsupported) {
      throw new SpeechToTextProviderError(unsupported);
    }

    const job: DownloadJob = {
      promise: Promise.resolve(),
      controller: new AbortController(),
      loadedByFile: new Map(),
      currentFile: null,
      cancelled: false,
    };
    this.downloads.set(model, job);
    this.errors.delete(model);

    job.promise = this.runDownload(spec, job)
      .then(() => {
        this.readyCache.set(model, true);
        this.logger.log(`Local Whisper model ready model=${model}`);
      })
      .catch((error: unknown) => {
        if (job.cancelled) {
          this.logger.log(`Local Whisper download cancelled model=${model}`);
          return;
        }
        const message = describeError(error);
        this.errors.set(model, message);
        this.logger.warn(
          `Local Whisper download failed model=${model} message=${message}`,
        );
      })
      .finally(() => {
        this.downloads.delete(model);
        void this.emitStatus(true);
      });

    void this.emitStatus(true);
    return job;
  }

  /**
   * Stops an in-flight download and removes what it had written. Partial files
   * are already excluded from readiness by the marker, but leaving hundreds of
   * megabytes behind after an explicit cancel would be its own surprise.
   */
  async cancelDownload(model: LocalWhisperModelId): Promise<void> {
    const job = this.downloads.get(model);
    if (!job) {
      return;
    }

    job.cancelled = true;
    job.controller.abort();
    await job.promise.catch(() => undefined);
    await this.remove(model);
  }

  /** Deletes a model's weights from disk. */
  async remove(model: LocalWhisperModelId): Promise<void> {
    const spec = findWhisperModel(model);
    if (!spec) {
      return;
    }
    if (this.downloads.has(model)) {
      throw new SpeechToTextProviderError(
        'That model is still downloading. Cancel the download first.',
      );
    }

    if (this.loadedModel === model) {
      // Queued so deleting the model someone is dictating with waits for that
      // dictation rather than disposing its weights mid-run.
      await this.runExclusive(() => this.evictPipeline());
    }

    await rm(join(this.cacheDir, ...spec.repo.split('/')), {
      recursive: true,
      force: true,
    });
    this.readyCache.set(model, false);
    this.errors.delete(model);
    await this.emitStatus(true);
  }

  /**
   * Runs Whisper on 16 kHz mono audio. Inference itself happens on ONNX
   * Runtime's own thread pool, but the token loop between calls runs here, so
   * requests are serialized to keep one dictation from starving another.
   */
  async transcribe(input: LocalWhisperTranscribeInput): Promise<string> {
    return this.runExclusive(() => this.runTranscription(input));
  }

  /**
   * Queues `task` behind anything else using the pipeline. The queue survives a
   * failing task — a rejection must not stop later work — and never keeps an
   * unhandled rejection on the shared tail.
   */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pipelineQueue.then(task, task);
    this.pipelineQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runTranscription(
    input: LocalWhisperTranscribeInput,
  ): Promise<string> {
    const unsupported = describeUnsupportedPlatform();
    if (unsupported) {
      throw new SpeechToTextProviderError(unsupported);
    }
    if (!(await this.isReady(input.model))) {
      const spec = findWhisperModel(input.model);
      throw new SpeechToTextProviderError(
        `${spec?.label ?? input.model} is not downloaded yet. Download it in Settings.`,
      );
    }

    const transcriber = await this.loadPipeline(input.model);

    try {
      const output = await transcriber(input.samples, {
        // Whisper only sees 30 s at a time; chunking with an overlap lets a
        // long dictation through without clipping words at the seams.
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false,
        ...(input.language ? { language: input.language } : {}),
      });

      return typeof output.text === 'string' ? output.text.trim() : '';
    } catch (error) {
      throw new SpeechToTextProviderError(
        `Local transcription failed: ${describeError(error)}`,
      );
    } finally {
      // Started only once inference is done: arming it beforehand would let the
      // idle timer dispose the pipeline underneath a dictation that simply took
      // longer than the timeout.
      this.scheduleEviction();
    }
  }

  private async loadPipeline(
    model: LocalWhisperModelId,
  ): Promise<WhisperPipeline> {
    if (this.loadedModel === model && this.pipelinePromise) {
      return this.pipelinePromise;
    }

    // Switching models: release the old weights before allocating new ones.
    await this.evictPipeline();

    const spec = findWhisperModel(model);
    if (!spec) {
      throw new SpeechToTextProviderError(`Unknown Whisper model: ${model}.`);
    }

    this.loadedModel = model;
    this.pipelinePromise = this.createPipeline(spec).catch(
      (error: unknown) => {
        // A failed load must not be cached, or every later attempt returns the
        // same rejected promise until the process restarts.
        this.loadedModel = null;
        this.pipelinePromise = null;
        throw error;
      },
    );
    return this.pipelinePromise;
  }

  private async createPipeline(
    spec: LocalWhisperModelSpec,
  ): Promise<WhisperPipeline> {
    const { pipeline } = await this.loadTransformers();
    const startedAt = Date.now();

    const transcriber = (await pipeline(
      'automatic-speech-recognition',
      spec.repo,
      { dtype: 'q8', device: 'cpu' },
    )) as unknown as WhisperPipeline;

    this.logger.log(
      `Loaded local Whisper model=${spec.id} elapsedMs=${Date.now() - startedAt}`,
    );
    return transcriber;
  }

  /**
   * Loads Transformers.js on first use. It pulls in ONNX Runtime's native
   * binding, which is tens of megabytes of process memory, so an install that
   * never dictates locally never pays for it.
   */
  private async loadTransformers(): Promise<TransformersModule> {
    if (this.transformersPromise) {
      return this.transformersPromise;
    }

    // Guarded again here so the success path below cannot clear a
    // platform-support message by loading something that was never going to.
    const unsupported = describeUnsupportedPlatform();
    if (unsupported) {
      throw new SpeechToTextProviderError(unsupported);
    }

    this.transformersPromise = (async () => {
      try {
        const transformers = (await import(
          '@huggingface/transformers'
        )) as unknown as TransformersModule;

        transformers.env.cacheDir = this.cacheDir;
        // Resolve strictly through our cache directory. Transformers.js
        // otherwise probes a `./models` path first, which would make "is this
        // downloaded" depend on the process's working directory.
        transformers.env.allowLocalModels = false;
        transformers.env.useFSCache = true;
        // Any file the pipeline wants beyond the ones downloaded above must go
        // through the same mirror, or a locked-down host fails at load time
        // having succeeded at download time.
        transformers.env.remoteHost = resolveHfEndpoint();

        this.engineError = null;
        return transformers;
      } catch (error) {
        this.engineError = `The local speech engine could not start: ${describeError(error)}`;
        this.transformersPromise = null;
        this.logger.error(this.engineError);
        throw new SpeechToTextProviderError(this.engineError);
      }
    })();

    return this.transformersPromise;
  }

  private scheduleEviction(): void {
    if (this.evictTimer) {
      clearTimeout(this.evictTimer);
    }
    this.evictTimer = setTimeout(() => {
      // Through the queue: a dictation that started between the timer being
      // armed and it firing must finish before the weights are released.
      void this.runExclusive(() => this.evictPipeline());
    }, PIPELINE_IDLE_EVICT_MS);
    // Never hold the process open just to expire a cache entry.
    this.evictTimer.unref?.();
  }

  private async evictPipeline(): Promise<void> {
    if (this.evictTimer) {
      clearTimeout(this.evictTimer);
      this.evictTimer = null;
    }

    const pending = this.pipelinePromise;
    this.pipelinePromise = null;
    this.loadedModel = null;
    if (!pending) {
      return;
    }

    try {
      const transcriber = await pending;
      await transcriber.dispose?.();
    } catch {
      // A pipeline that never loaded has nothing to release.
    }
  }

  private async runDownload(
    spec: LocalWhisperModelSpec,
    job: DownloadJob,
  ): Promise<void> {
    const modelDir = join(this.cacheDir, ...spec.repo.split('/'));
    await mkdir(modelDir, { recursive: true });

    // Weights first: they are the slow part, and a user watching the bar wants
    // it to reflect the download they are actually waiting on.
    for (const file of [...WHISPER_ONNX_FILES, ...WHISPER_SUPPORT_FILES]) {
      if (job.cancelled) {
        throw new DownloadCancelled();
      }

      const optional = !WHISPER_ONNX_FILES.includes(
        file as (typeof WHISPER_ONNX_FILES)[number],
      );
      job.currentFile = file;
      await this.fetchFile(spec, file, job, optional);
    }

    job.currentFile = null;
    if (job.cancelled) {
      throw new DownloadCancelled();
    }

    // Proves the files on disk actually produce a working pipeline before this
    // model is advertised as ready, and leaves it warm for the first dictation.
    //
    // Queued rather than called directly: loading a different model evicts the
    // resident one, and a background download finishing mid-dictation would
    // otherwise dispose the weights that dictation is using.
    await this.runExclusive(async () => {
      await this.loadPipeline(spec.id);
    });
    await writeFile(join(modelDir, COMPLETE_MARKER), spec.repo, 'utf8');
    this.scheduleEviction();
  }

  /**
   * Streams one file into the layout Transformers.js reads
   * (`<cacheDir>/<repo>/<file>`), writing through a temporary name so an
   * interrupted transfer can never be mistaken for a complete file.
   */
  private async fetchFile(
    spec: LocalWhisperModelSpec,
    file: string,
    job: DownloadJob,
    optional: boolean,
  ): Promise<void> {
    const destination = join(this.cacheDir, ...spec.repo.split('/'), ...file.split('/'));
    if (await exists(destination)) {
      // Already cached from an earlier attempt; count it so resuming a failed
      // download does not restart the progress bar at zero.
      const stats = await stat(destination);
      job.loadedByFile.set(file, stats.size);
      this.emitProgress(job);
      return;
    }

    const endpoint = resolveHfEndpoint();
    const url = `${endpoint}/${spec.repo}/resolve/main/${file}`;
    let response: Response;
    try {
      response = await fetch(url, { signal: job.controller.signal });
    } catch (error) {
      if (job.cancelled) {
        throw new DownloadCancelled();
      }
      throw new SpeechToTextProviderError(
        `Could not reach ${endpoint}: ${describeError(error)}`,
      );
    }

    if (response.status === 404 && optional) {
      // Not every repo ships every config file; the pipeline copes, and
      // treating it as fatal would block otherwise-usable models.
      return;
    }
    if (!response.ok || !response.body) {
      throw new SpeechToTextProviderError(
        `Downloading ${file} failed with HTTP ${response.status}.`,
      );
    }

    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.part`;

    let loaded = 0;
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', (chunk: Buffer) => {
      loaded += chunk.length;
      job.loadedByFile.set(file, loaded);
      this.emitProgress(job);
    });

    try {
      await streamPipeline(body, createWriteStream(temporary), {
        signal: job.controller.signal,
      });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (job.cancelled) {
        throw new DownloadCancelled();
      }
      throw new SpeechToTextProviderError(
        `Downloading ${file} failed: ${describeError(error)}`,
      );
    }
  }

  private async describe(
    spec: LocalWhisperModelSpec,
  ): Promise<LocalWhisperModelState> {
    const job = this.downloads.get(spec.id);
    const error = this.errors.get(spec.id) ?? null;
    const ready = job ? false : await this.isReady(spec.id);

    const loadedBytes = job ? sumLoaded(job) : 0;
    return {
      ...spec,
      status: job
        ? 'downloading'
        : ready
          ? 'ready'
          : error
            ? 'error'
            : 'not-downloaded',
      loadedBytes,
      progress: job
        ? Math.min(1, loadedBytes / spec.downloadBytes)
        : ready
          ? 1
          : 0,
      currentFile: job?.currentFile ?? null,
      error,
      loadedInMemory: this.loadedModel === spec.id,
    };
  }

  private async hasCompleteDownload(
    spec: LocalWhisperModelSpec,
  ): Promise<boolean> {
    const modelDir = join(this.cacheDir, ...spec.repo.split('/'));
    if (!(await exists(join(modelDir, COMPLETE_MARKER)))) {
      return false;
    }

    const weights = await Promise.all(
      WHISPER_ONNX_FILES.map((file) =>
        exists(join(modelDir, ...file.split('/'))),
      ),
    );
    return weights.every(Boolean);
  }

  /**
   * Throttled globally rather than per model: each emission carries a full
   * status snapshot covering every model, so one is enough for all of them.
   */
  private emitProgress(job: DownloadJob): void {
    if (job.cancelled) {
      return;
    }
    const now = Date.now();
    if (now - this.lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) {
      return;
    }
    this.lastEmitAt = now;
    void this.emitStatus(false);
  }

  private async emitStatus(force: boolean): Promise<void> {
    if (force) {
      this.lastEmitAt = Date.now();
    }
    if (this.changesSubject.observed) {
      this.changesSubject.next(await this.getStatus());
    }
  }
}

/** Internal signal; never surfaced to the client as an error. */
class DownloadCancelled extends Error {
  constructor() {
    super('Download cancelled.');
    this.name = 'DownloadCancelled';
  }
}

type TransformersModule = {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  env: {
    cacheDir: string | null;
    allowLocalModels: boolean;
    useFSCache: boolean;
    remoteHost: string;
  };
};

function sumLoaded(job: DownloadJob): number {
  let total = 0;
  for (const bytes of job.loadedByFile.values()) {
    total += bytes;
  }
  return total;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
