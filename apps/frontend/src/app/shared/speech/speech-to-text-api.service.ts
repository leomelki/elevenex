import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { SpeechToTextProviderId } from '@/shared/models/app-settings.model';

export interface TranscriptionResponse {
  /** What the STT provider returned. Cleanup is a separate call. */
  text: string;
  provider: SpeechToTextProviderId;
  model: string;
  transcribeMs: number;
  /** Whether calling `cleanup` afterwards would do anything. */
  cleanupAvailable: boolean;
}

export interface CleanupResponse {
  text: string;
  applied: boolean;
  elapsedMs: number;
}

export interface TranscribeOptions {
  audio: Blob;
  sessionId?: number | null;
  worktreePath?: string | null;
  /** Settings "test microphone" round trip; skips cleanup. */
  test?: boolean;
}

@Injectable({ providedIn: 'root' })
export class SpeechToTextApiService {
  private readonly http = inject(HttpClient);

  /**
   * Posts the recording as a raw body with its codec in `Content-Type`. The
   * api-base interceptor rewrites the origin, so this works unchanged against
   * a local, SSH-tunnelled or WSL backend.
   */
  async transcribe(
    options: TranscribeOptions,
  ): Promise<TranscriptionResponse> {
    const params: Record<string, string> = {};
    if (options.sessionId != null) {
      params['sessionId'] = String(options.sessionId);
    }
    if (options.worktreePath) {
      params['worktreePath'] = options.worktreePath;
    }

    const path = options.test
      ? '/api/speech-to-text/test'
      : '/api/speech-to-text/transcribe';

    try {
      return await firstValueFrom(
        this.http.post<TranscriptionResponse>(path, options.audio, {
          params,
          headers: {
            'Content-Type': options.audio.type || 'application/octet-stream',
          },
        }),
      );
    } catch (error) {
      throw new Error(describeHttpError(error));
    }
  }

  /**
   * Tidies a transcript that is already on screen. Returns the input unchanged
   * with `applied: false` on any failure, so the caller can fire this without
   * risking the user's dictated words.
   */
  async cleanup(options: {
    text: string;
    sessionId?: number | null;
    worktreePath?: string | null;
  }): Promise<CleanupResponse> {
    try {
      return await firstValueFrom(
        this.http.post<CleanupResponse>('/api/speech-to-text/cleanup', {
          text: options.text,
          ...(options.sessionId != null ? { sessionId: options.sessionId } : {}),
          ...(options.worktreePath
            ? { worktreePath: options.worktreePath }
            : {}),
        }),
      );
    } catch {
      return { text: options.text, applied: false, elapsedMs: 0 };
    }
  }
}

/** The backend already phrases these for humans; surface that, not a status code. */
function describeHttpError(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const message = (error.error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
    if (Array.isArray(message) && typeof message[0] === 'string') {
      return message[0];
    }
    if (error.status === 0) {
      return 'Could not reach the Elevenex backend.';
    }
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Transcription failed.';
}
