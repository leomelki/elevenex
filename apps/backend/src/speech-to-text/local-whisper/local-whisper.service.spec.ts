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
        language: null,
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

  it('will not delete a model out from under a running download', async () => {
    service.download('tiny');

    await expect(service.remove('tiny')).rejects.toThrow(/still downloading/i);

    await service.cancelDownload('tiny');
  });
});
