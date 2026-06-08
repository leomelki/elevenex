import { Injectable } from '@angular/core';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import type { ComposerImageAttachment } from './components/claude-composer.component';

export interface ComposerDraft {
  version: 1;
  sessionId: number;
  text: string;
  diffMentions: DiffSelectionMention[];
  images: ComposerImageAttachment[];
  updatedAt: string;
}

const DB_NAME = 'elevenex-composer-drafts';
const DB_VERSION = 1;
const STORE_NAME = 'drafts';

@Injectable({ providedIn: 'root' })
export class ComposerDraftService {
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  async load(sessionId: number): Promise<ComposerDraft | null> {
    if (!this.isValidSessionId(sessionId)) return null;

    try {
      const db = await this.openDb();
      if (!db) return null;
      const raw = await this.request<unknown>(
        db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(sessionId),
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

  async save(draft: Omit<ComposerDraft, 'version' | 'updatedAt'>): Promise<void> {
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
        sessionId: draft.sessionId,
        text: draft.text,
        diffMentions: draft.diffMentions,
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
        db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(sessionId),
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

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
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
      sessionId,
      text: value.text,
      diffMentions: value.diffMentions as DiffSelectionMention[],
      images,
      updatedAt: value.updatedAt,
    };
  }

  private hasContent(draft: Pick<ComposerDraft, 'text' | 'diffMentions' | 'images'>): boolean {
    return !!draft.text.trim() || draft.diffMentions.length > 0 || draft.images.length > 0;
  }

  private isValidSessionId(sessionId: number): boolean {
    return Number.isInteger(sessionId) && sessionId > 0;
  }

  private warn(message: string, error?: unknown): void {
    console.warn(`[composer-draft] ${message}`, error ?? '');
  }
}
