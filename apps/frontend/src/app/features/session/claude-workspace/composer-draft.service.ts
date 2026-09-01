import { Injectable } from '@angular/core';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import type { ComposerImageAttachment } from './components/claude-composer.component';
import type { SessionMention } from '@/shared/models/session-mention.model';
import { getBackendServerId } from '@/shared/runtime/runtime-config';

export interface ComposerDraft {
  version: 1;
  /** `<backendServerId>:<sessionId>` — the IndexedDB key path. */
  draftKey: string;
  sessionId: number;
  text: string;
  diffMentions: DiffSelectionMention[];
  sessionMentions: SessionMention[];
  images: ComposerImageAttachment[];
  updatedAt: string;
}

const DB_NAME = 'elevenex-composer-drafts';
// v2 re-keys drafts by backend + session. Session ids are only unique within
// one backend, so with two backends open at once (or even just switched
// between) drafts written against one could silently overwrite another's.
const DB_VERSION = 2;
const STORE_NAME = 'drafts';

function buildDraftKey(sessionId: number): string {
  return `${getBackendServerId()}:${sessionId}`;
}

@Injectable({ providedIn: 'root' })
export class ComposerDraftService {
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  async load(sessionId: number): Promise<ComposerDraft | null> {
    if (!this.isValidSessionId(sessionId)) return null;

    try {
      const db = await this.openDb();
      if (!db) return null;
      const raw = await this.request<unknown>(
        db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(buildDraftKey(sessionId)),
      );
      const draft = this.parseDraft(raw, sessionId);
      if (!draft && raw !== undefined) {
        await this.delete(sessionId);
      }
      return draft;
    } catch (error) {
      this.warn('Could not load composer draft.', error);
      return null;
    }
  }

  async save(
    // `draftKey` is derived here from the caller's sessionId — callers have no
    // reason to know about the backend namespace.
    draft: Omit<ComposerDraft, 'version' | 'updatedAt' | 'sessionMentions' | 'draftKey'> & {
      sessionMentions?: SessionMention[];
    },
  ): Promise<void> {
    if (!this.isValidSessionId(draft.sessionId)) return;
    if (!this.hasContent(draft)) {
      await this.delete(draft.sessionId);
      return;
    }

    try {
      const db = await this.openDb();
      if (!db) return;
      const next: ComposerDraft = {
        version: 1,
        draftKey: buildDraftKey(draft.sessionId),
        sessionId: draft.sessionId,
        text: draft.text,
        diffMentions: draft.diffMentions,
        sessionMentions: draft.sessionMentions ?? [],
        images: draft.images,
        updatedAt: new Date().toISOString(),
      };
      await this.request(
        db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(next),
      );
    } catch (error) {
      this.warn('Could not save composer draft.', error);
    }
  }

  async delete(sessionId: number): Promise<void> {
    if (!this.isValidSessionId(sessionId)) return;

    try {
      const db = await this.openDb();
      if (!db) return;
      await this.request(
        db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(buildDraftKey(sessionId)),
      );
    } catch (error) {
      this.warn('Could not delete composer draft.', error);
    }
  }

  private async openDb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return null;
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'draftKey' });
          return;
        }

        if ((event.oldVersion ?? 0) < 2) {
          // Re-key the v1 store, which was keyed on sessionId alone. Existing
          // drafts are attributed to the backend this window is on — the only
          // information available, and better than discarding the user's
          // unsent text. Runs inside the versionchange transaction, so the
          // read, the drop and the rewrite are atomic.
          const upgradeTransaction = request.transaction;
          const legacyStore = upgradeTransaction?.objectStore(STORE_NAME);
          const readAll = legacyStore?.getAll();
          if (!readAll) return;

          readAll.onsuccess = () => {
            const legacyDrafts = (readAll.result ?? []) as ComposerDraft[];
            db.deleteObjectStore(STORE_NAME);
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'draftKey' });
            for (const legacyDraft of legacyDrafts) {
              if (!Number.isInteger(legacyDraft?.sessionId)) continue;
              store.put({ ...legacyDraft, draftKey: buildDraftKey(legacyDraft.sessionId) });
            }
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.warn('Could not open composer draft storage.', request.error);
        resolve(null);
      };
      request.onblocked = () => {
        this.warn('Composer draft storage is blocked by another tab.');
      };
    });

    return this.dbPromise;
  }

  private request<T = unknown>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  }

  private parseDraft(raw: unknown, sessionId: number): ComposerDraft | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Partial<ComposerDraft>;
    if (value.version !== 1 || value.sessionId !== sessionId) return null;
    if (typeof value.text !== 'string') return null;
    if (!Array.isArray(value.diffMentions) || !Array.isArray(value.images)) return null;
    if (typeof value.updatedAt !== 'string') return null;

    const images = value.images.filter((image): image is ComposerImageAttachment => {
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
    });

    return {
      version: 1,
      draftKey: buildDraftKey(sessionId),
      sessionId,
      text: value.text,
      diffMentions: value.diffMentions as DiffSelectionMention[],
      sessionMentions: Array.isArray(value.sessionMentions)
        ? (value.sessionMentions as SessionMention[])
        : [],
      images,
      updatedAt: value.updatedAt,
    };
  }

  private hasContent(
    draft: Pick<ComposerDraft, 'text' | 'diffMentions' | 'images'> & {
      sessionMentions?: SessionMention[];
    },
  ): boolean {
    return (
      !!draft.text.trim() ||
      draft.diffMentions.length > 0 ||
      (draft.sessionMentions?.length ?? 0) > 0 ||
      draft.images.length > 0
    );
  }

  private isValidSessionId(sessionId: number): boolean {
    return Number.isInteger(sessionId) && sessionId > 0;
  }

  private warn(message: string, error?: unknown): void {
    console.warn(`[composer-draft] ${message}`, error ?? '');
  }
}
