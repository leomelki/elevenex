import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalWhisperStatus } from '@/shared/models/local-whisper.model';
import { ONBOARDING_STORAGE_KEY } from '@/shared/services/onboarding-state.service';
import { LocalWhisperService } from './local-whisper.service';

/**
 * The backend location comes from the onboarding snapshot in localStorage, so
 * these drive the real resolution rather than mocking `runtime-config` — which
 * would not prove the origin is read the way the app reads it.
 */
function connectLocal(): void {
  localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  window.__ELEVENEX_RUNTIME__ = { backendOrigin: 'http://127.0.0.1:11111' };
}

function connectWsl(localPort = 22_222): void {
  localStorage.setItem(
    ONBOARDING_STORAGE_KEY,
    JSON.stringify({
      mode: 'wsl',
      remoteConnectionReady: true,
      wsl: { distro: 'Ubuntu', localPort, remotePort: 11_111 },
    }),
  );
}

function connectSsh(id = 2, localPort = 33_333): void {
  localStorage.setItem(
    ONBOARDING_STORAGE_KEY,
    JSON.stringify({
      mode: 'ssh',
      remoteConnectionReady: true,
      activeServerId: id,
      servers: [
        {
          id,
          name: 'build-box',
          sshHost: '10.0.0.5',
          sshUser: 'dev',
          authMode: 'agent',
          // Must be one of the values `sanitizeServer` accepts, or the entry is
          // dropped and the snapshot silently falls back to the local backend.
          installStatus: 'available',
          sshPort: 22,
          localPort,
          remotePort: 11_111,
        },
      ],
    }),
  );
}

function status(overrides: Partial<LocalWhisperStatus> = {}): LocalWhisperStatus {
  return {
    engineAvailable: true,
    engineError: null,
    cacheDir: '/home/user/.elevenex/whisper-models',
    selectedModel: 'small',
    models: [
      {
        id: 'small',
        label: 'Whisper Small',
        repo: 'onnx-community/whisper-small',
        downloadBytes: 254_000_000,
        speed: 'moderate',
        description: 'Balanced.',
        status: 'ready',
        loadedBytes: 254_000_000,
        progress: 1,
        currentFile: null,
        error: null,
        loadedInMemory: false,
      },
    ],
    ...overrides,
  };
}

describe('LocalWhisperService', () => {
  let service: LocalWhisperService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    connectLocal();

    TestBed.configureTestingModule({
      providers: [
        LocalWhisperService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });

    service = TestBed.inject(LocalWhisperService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    delete window.__ELEVENEX_RUNTIME__;
  });

  it('coalesces concurrent refreshes into one request', async () => {
    const first = service.refresh();
    const second = service.refresh();

    httpMock
      .expectOne('/api/speech-to-text/local-models')
      .flush(status());
    await Promise.all([first, second]);

    expect(service.selectedModelReady()).toBe(true);
  });

  it('serves the cached status rather than re-fetching per mic button', async () => {
    const load = service.ensureLoaded();
    httpMock.expectOne('/api/speech-to-text/local-models').flush(status());
    await load;

    await service.ensureLoaded();
    // A second call must not queue another request; httpMock.verify() in
    // afterEach would fail if it had.
    expect(service.models()).toHaveLength(1);
  });

  it('drops state when the backend origin changes', async () => {
    const load = service.ensureLoaded();
    httpMock.expectOne('/api/speech-to-text/local-models').flush(status());
    await load;
    expect(service.selectedModelReady()).toBe(true);

    // Reconnecting to a remote host: the previous machine's downloads say
    // nothing about this one, and treating them as current would enable a mic
    // that cannot work.
    connectSsh();

    const reload = service.ensureLoaded();
    expect(service.selectedModelReady()).toBe(false);
    expect(service.backendKind()).toBe('remote');

    httpMock
      .expectOne('/api/speech-to-text/local-models')
      .flush(status({ models: [] }));
    await reload;
  });

  it('ignores a response that arrives after the backend changed', async () => {
    const stale = service.refresh();
    const request = httpMock.expectOne('/api/speech-to-text/local-models');

    connectSsh();
    service.ensureLoaded().catch(() => undefined);
    const fresh = httpMock.expectOne('/api/speech-to-text/local-models');

    // The first backend answers late; its models must not be adopted.
    request.flush(status());
    await stale;
    expect(service.models()).toHaveLength(0);

    fresh.flush(status({ models: [] }));
  });

  it('reports WSL separately, since "this device" would be wrong there', async () => {
    connectWsl();

    const load = service.ensureLoaded();
    httpMock.expectOne('/api/speech-to-text/local-models').flush(status());
    await load;

    expect(service.backendKind()).toBe('wsl');
  });

  it('surfaces the backend message when a download cannot start', async () => {
    const attempt = service.startDownload('small');
    httpMock
      .expectOne('/api/speech-to-text/local-models/small/download')
      .flush(
        { message: 'Offline dictation needs an Apple silicon Mac.' },
        { status: 400, statusText: 'Bad Request' },
      );

    await expect(attempt).rejects.toThrow(/Apple silicon/);
    expect(service.error()).toMatch(/Apple silicon/);
  });
});
