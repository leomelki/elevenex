import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  EMPTY_LOCAL_WHISPER_STATUS,
  LocalWhisperStatus,
} from '@/shared/models/local-whisper.model';
import { LocalWhisperModelId } from '@/shared/models/app-settings.model';
import { getApiBaseUrl, getBackendOrigin } from '@/shared/runtime/runtime-config';

const BASE_PATH = '/api/speech-to-text/local-models';

/** Poll cadence used when the browser or a proxy cannot hold the SSE stream. */
const FALLBACK_POLL_MS = 1_000;

/**
 * Tracks the offline Whisper models the backend has on disk, and drives their
 * downloads.
 *
 * Downloads live on the backend, not here: they run for minutes and must
 * survive the settings page being closed, so this only ever starts one and
 * watches its progress.
 */
@Injectable({ providedIn: 'root' })
export class LocalWhisperService {
  private readonly http = inject(HttpClient);

  private readonly statusState = signal<LocalWhisperStatus>(
    EMPTY_LOCAL_WHISPER_STATUS,
  );
  readonly status = this.statusState.asReadonly();
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Coalesces concurrent refreshes into one request. */
  private inFlight: Promise<LocalWhisperStatus> | null = null;
  private loadedOrigin: string | null = null;
  private watchers = 0;
  private source: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly models = computed(() => this.statusState().models);

  /** The build dictation would use right now, if the backend has reported one. */
  readonly selectedModel = computed(() => {
    const status = this.statusState();
    return (
      status.models.find((model) => model.id === status.selectedModel) ?? null
    );
  });

  /** Whether local dictation could run without downloading anything first. */
  readonly selectedModelReady = computed(
    () => this.selectedModel()?.status === 'ready',
  );

  readonly downloadingModel = computed(
    () => this.models().find((model) => model.status === 'downloading') ?? null,
  );

  /** Fetches once per backend origin; later calls reuse the cached state. */
  ensureLoaded(): Promise<LocalWhisperStatus> {
    const origin = getBackendOrigin();
    if (this.loadedOrigin === origin && !this.inFlight) {
      return Promise.resolve(this.statusState());
    }
    return this.refresh();
  }

  refresh(): Promise<LocalWhisperStatus> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const origin = getBackendOrigin();
    this.loading.set(true);
    this.inFlight = firstValueFrom(this.http.get<LocalWhisperStatus>(BASE_PATH))
      .then((status) => {
        this.loadedOrigin = origin;
        this.apply(status);
        this.error.set(null);
        return status;
      })
      .catch((error: unknown) => {
        this.error.set(
          describeError(error, 'Could not read local model status.'),
        );
        throw error;
      })
      .finally(() => {
        this.loading.set(false);
        this.inFlight = null;
      });

    return this.inFlight;
  }

  async startDownload(model: LocalWhisperModelId): Promise<void> {
    await this.act(
      this.http.post<LocalWhisperStatus>(`${BASE_PATH}/${model}/download`, {}),
      'Could not start the download.',
    );
  }

  async cancelDownload(model: LocalWhisperModelId): Promise<void> {
    await this.act(
      this.http.post<LocalWhisperStatus>(`${BASE_PATH}/${model}/cancel`, {}),
      'Could not cancel the download.',
    );
  }

  async remove(model: LocalWhisperModelId): Promise<void> {
    await this.act(
      this.http.delete<LocalWhisperStatus>(`${BASE_PATH}/${model}`),
      'Could not delete the model.',
    );
  }

  /**
   * Streams status while the settings page is open. Returns a teardown; the
   * stream is shared, so several callers cost one connection.
   */
  watch(): () => void {
    this.watchers += 1;
    if (this.watchers === 1) {
      this.openStream();
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.watchers -= 1;
      if (this.watchers === 0) {
        this.closeStream();
      }
    };
  }

  private openStream(): void {
    void this.refresh().catch(() => undefined);

    try {
      const source = new EventSource(`${getApiBaseUrl()}/speech-to-text/local-models/stream`);
      this.source = source;

      source.addEventListener('status', (event) => {
        try {
          this.apply(JSON.parse((event as MessageEvent<string>).data));
          this.error.set(null);
        } catch {
          // A malformed frame is not worth tearing the stream down for; the
          // next one, or the fallback poll, will correct the display.
        }
      });

      // EventSource reports neither status nor body on failure, and a proxy
      // that buffers SSE looks identical to a dead backend. Fall back to
      // polling rather than leaving the download bar frozen.
      source.addEventListener('error', () => {
        this.closeStream();
        if (this.watchers > 0) {
          this.startPolling();
        }
      });
    } catch {
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, FALLBACK_POLL_MS);
  }

  private closeStream(): void {
    this.source?.close();
    this.source = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async act(
    request: Parameters<typeof firstValueFrom<LocalWhisperStatus>>[0],
    fallback: string,
  ): Promise<void> {
    try {
      this.apply(await firstValueFrom(request));
      this.error.set(null);
    } catch (error) {
      const message = describeError(error, fallback);
      this.error.set(message);
      throw new Error(message);
    }
  }

  private apply(status: LocalWhisperStatus | null | undefined): void {
    if (!status || !Array.isArray(status.models)) {
      return;
    }
    this.statusState.set(status);
  }
}

/** The backend phrases these for humans; prefer its message to a status code. */
function describeError(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const message = (error.error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
    if (error.status === 0) {
      return 'Could not reach the Elevenex backend.';
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
