import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import type { ComposerImageAttachment } from './components/claude-composer.component';
import type { SessionMention } from '@/shared/models/session-mention.model';
import { getBackendOrigin } from '@/shared/runtime/runtime-config';

export interface ComposerDraft {
  sessionId: number;
  text: string;
  diffMentions: DiffSelectionMention[];
  sessionMentions: SessionMention[];
  images: ComposerImageAttachment[];
  updatedAt: string;
}

export interface SaveComposerDraftInput {
  sessionId: number;
  text: string;
  diffMentions: DiffSelectionMention[];
  sessionMentions?: SessionMention[];
  images: ComposerImageAttachment[];
}

interface DraftPayload {
  text: string;
  diffMentions: DiffSelectionMention[];
  sessionMentions: SessionMention[];
  images: ComposerImageAttachment[];
}

/**
 * Long enough that a burst of typing is one request, short enough that a draft
 * is on the server before the user can reach for the window's close button.
 */
const SAVE_DEBOUNCE_MS = 400;
const RETRY_BASE_MS = 2_000;
const MAX_RETRIES = 3;

/** IndexedDB database used by the pre-server draft store. */
const LEGACY_DB_NAME = 'elevenex-composer-drafts';

let legacyStoreCleared = false;

/**
 * Drops the browser-local draft store this service used to keep.
 *
 * It was keyed on the session id, which only means anything inside one backend
 * database — but a renderer's storage is shared by every window and outlives
 * switching environment, reinstalling, or restoring a database. Drafts from a
 * long-gone session therefore surfaced in whatever session later happened to
 * take that id. The rows are unattributable by construction, so they are
 * deleted rather than migrated: re-homing them would just move the bug to the
 * server.
 */
function clearLegacyLocalDrafts(): void {
  if (legacyStoreCleared || typeof indexedDB === 'undefined') return;
  legacyStoreCleared = true;

  try {
    indexedDB.deleteDatabase(LEGACY_DB_NAME);
  } catch {
    // Best effort: a blocked or unavailable IndexedDB must not break the app.
  }
}

function imagesKeyOf(images: readonly ComposerImageAttachment[]): string {
  return images.map((image) => `${image.id}:${image.size}`).join('|');
}

function isEmptyDraft(payload: DraftPayload): boolean {
  return (
    !payload.text.trim() &&
    payload.diffMentions.length === 0 &&
    payload.sessionMentions.length === 0 &&
    payload.images.length === 0
  );
}

/**
 * Unsent composer text, stored on the backend next to the session it belongs
 * to.
 *
 * The session id is the identity of a row in *that* backend's database, so a
 * draft can only ever come back to the composer it was written in, and it dies
 * with the session (foreign key cascade). Writes are debounced and serialized
 * per session, so typing costs one request per pause and a slow response can
 * never land on top of a newer one.
 */
@Injectable({ providedIn: 'root' })
export class ComposerDraftService {
  private readonly http = inject(HttpClient);

  /** Latest unwritten state per session. */
  private readonly pending = new Map<number, DraftPayload>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<number, Promise<void>>();
  private readonly retries = new Map<number, number>();
  /**
   * Attachment set the server is known to hold. Images are base64 data URLs;
   * resending them on every keystroke would push megabytes down an SSH tunnel
   * for a one-character edit, so the payload omits them while they are
   * unchanged and the backend keeps what it has.
   */
  private readonly savedImagesKeys = new Map<number, string>();

  constructor() {
    clearLegacyLocalDrafts();
    this.flushOnUnload();
  }

  async load(sessionId: number): Promise<ComposerDraft | null> {
    if (!this.isValidSessionId(sessionId)) return null;

    // An unwritten local edit is newer than anything the server can return.
    const pending = this.pending.get(sessionId);
    if (pending) {
      return isEmptyDraft(pending)
        ? null
        : { sessionId, ...pending, updatedAt: new Date().toISOString() };
    }

    try {
      const raw = await firstValueFrom(
        this.http.get<unknown>(this.draftUrl(sessionId)),
      );
      const draft = this.parseDraft(raw, sessionId);
      this.savedImagesKeys.set(sessionId, imagesKeyOf(draft?.images ?? []));
      return draft;
    } catch (error) {
      this.warn('Could not load composer draft.', error);
      return null;
    }
  }

  save(draft: SaveComposerDraftInput): void {
    if (!this.isValidSessionId(draft.sessionId)) return;

    this.pending.set(draft.sessionId, {
      text: draft.text,
      diffMentions: draft.diffMentions,
      sessionMentions: draft.sessionMentions ?? [],
      images: draft.images,
    });
    this.retries.set(draft.sessionId, 0);
    this.schedule(draft.sessionId, SAVE_DEBOUNCE_MS);
  }

  /** Clears the draft now — the composer was sent or emptied deliberately. */
  delete(sessionId: number): void {
    if (!this.isValidSessionId(sessionId)) return;

    this.pending.set(sessionId, {
      text: '',
      diffMentions: [],
      sessionMentions: [],
      images: [],
    });
    this.retries.set(sessionId, 0);
    this.schedule(sessionId, 0);
  }

  /** Writes anything still debounced. */
  async flush(sessionId: number): Promise<void> {
    if (!this.pending.has(sessionId) && !this.inFlight.has(sessionId)) return;
    this.clearTimer(sessionId);
    await this.pump(sessionId);
  }

  private schedule(sessionId: number, delay: number): void {
    this.clearTimer(sessionId);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        void this.pump(sessionId);
      }, delay),
    );
  }

  private clearTimer(sessionId: number): void {
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
  }

  /**
   * Drains this session's queue. One request at a time per session: a write
   * that is overtaken by a newer one is simply followed by it, so the last
   * state the user saw is the last state written.
   */
  private async pump(sessionId: number): Promise<void> {
    const running = this.inFlight.get(sessionId);
    if (running) return running;

    const run = (async () => {
      while (this.pending.has(sessionId)) {
        const payload = this.pending.get(sessionId)!;
        this.pending.delete(sessionId);

        if (await this.write(sessionId, payload)) {
          this.retries.set(sessionId, 0);
          continue;
        }

        // Failed. Try again with what is now current — a backend that is
        // momentarily unreachable (reconnecting tunnel, restarting server)
        // must not cost the user their text. Anything the user typed while
        // the request was in flight supersedes the payload that failed.
        if (!this.pending.has(sessionId)) {
          this.pending.set(sessionId, payload);
        }

        const attempt = (this.retries.get(sessionId) ?? 0) + 1;
        if (attempt > MAX_RETRIES) {
          this.warn(`Giving up on saving the draft for session ${sessionId}.`);
          this.pending.delete(sessionId);
          break;
        }
        this.retries.set(sessionId, attempt);
        this.schedule(sessionId, RETRY_BASE_MS * 2 ** (attempt - 1));
        break;
      }
    })();

    this.inFlight.set(sessionId, run);
    try {
      await run;
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private async write(sessionId: number, payload: DraftPayload): Promise<boolean> {
    try {
      if (isEmptyDraft(payload)) {
        await firstValueFrom(this.http.delete(this.draftUrl(sessionId)));
        this.savedImagesKeys.set(sessionId, '');
        return true;
      }

      const imagesKey = imagesKeyOf(payload.images);
      await firstValueFrom(
        this.http.put(this.draftUrl(sessionId), this.buildBody(sessionId, payload)),
      );
      this.savedImagesKeys.set(sessionId, imagesKey);
      return true;
    } catch (error) {
      // The session is gone, so there is nothing left to save for it.
      if (error instanceof HttpErrorResponse && error.status === 404) {
        this.savedImagesKeys.delete(sessionId);
        return true;
      }
      this.warn('Could not save composer draft.', error);
      return false;
    }
  }

  private buildBody(
    sessionId: number,
    payload: DraftPayload,
    options: { withImages?: boolean } = {},
  ): Record<string, unknown> {
    const imagesKey = imagesKeyOf(payload.images);
    const imagesChanged = this.savedImagesKeys.get(sessionId) !== imagesKey;

    return {
      text: payload.text,
      diffMentions: payload.diffMentions,
      sessionMentions: payload.sessionMentions,
      ...(imagesChanged && options.withImages !== false
        ? { images: payload.images }
        : {}),
    };
  }

  /**
   * Last chance to persist a debounced draft when the window goes away.
   * `keepalive` requests survive the teardown that cancels ordinary XHRs, but
   * are capped at 64 kB — attachments are left out, which is safe because the
   * backend keeps the images it already holds when the field is absent.
   */
  private flushOnUnload(): void {
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;

    window.addEventListener('pagehide', () => {
      for (const [sessionId, payload] of this.pending) {
        this.clearTimer(sessionId);
        const url = `${getBackendOrigin()}${this.draftUrl(sessionId)}`;
        try {
          if (isEmptyDraft(payload)) {
            void fetch(url, { method: 'DELETE', keepalive: true });
            continue;
          }
          void fetch(url, {
            method: 'PUT',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.buildBody(sessionId, payload, { withImages: false })),
          });
        } catch {
          // Nothing useful to do while the page is being torn down.
        }
      }
      this.pending.clear();
    });
  }

  private draftUrl(sessionId: number): string {
    return `/api/sessions/${sessionId}/composer-draft`;
  }

  private parseDraft(raw: unknown, sessionId: number): ComposerDraft | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Partial<ComposerDraft>;
    if (typeof value.text !== 'string') return null;
    if (typeof value.updatedAt !== 'string') return null;

    const images = (Array.isArray(value.images) ? value.images : []).filter(
      (image): image is ComposerImageAttachment => {
        if (!image || typeof image !== 'object') return false;
        const candidate = image as Partial<ComposerImageAttachment>;
        return (
          typeof candidate.id === 'string' &&
          typeof candidate.name === 'string' &&
          (candidate.mediaType === 'image/png' ||
            candidate.mediaType === 'image/jpeg' ||
            candidate.mediaType === 'image/gif' ||
            candidate.mediaType === 'image/webp') &&
          typeof candidate.dataUrl === 'string' &&
          typeof candidate.size === 'number'
        );
      },
    );

    return {
      sessionId,
      text: value.text,
      diffMentions: Array.isArray(value.diffMentions)
        ? (value.diffMentions as DiffSelectionMention[])
        : [],
      sessionMentions: Array.isArray(value.sessionMentions)
        ? (value.sessionMentions as SessionMention[])
        : [],
      images,
      updatedAt: value.updatedAt,
    };
  }

  private isValidSessionId(sessionId: number): boolean {
    return Number.isInteger(sessionId) && sessionId > 0;
  }

  private warn(message: string, error?: unknown): void {
    console.warn(`[composer-draft] ${message}`, error ?? '');
  }
}
