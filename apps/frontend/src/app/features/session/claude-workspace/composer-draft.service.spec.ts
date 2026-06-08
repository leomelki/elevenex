import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerDraftService } from './composer-draft.service';
import type { ComposerImageAttachment } from './components/claude-composer.component';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';

class FakeObjectStore {
  constructor(private readonly records: Map<number, unknown>) {}

  get(key: number): IDBRequest<unknown> {
    return fakeRequest(this.records.get(key));
  }

  put(value: { sessionId: number }): IDBRequest<IDBValidKey> {
    this.records.set(value.sessionId, value);
    return fakeRequest<IDBValidKey>(value.sessionId);
  }

  delete(key: number): IDBRequest<undefined> {
    this.records.delete(key);
    return fakeRequest(undefined);
  }
}

class FakeDatabase {
  readonly records = new Map<number, unknown>();
  readonly objectStoreNames = {
    contains: (name: string) => name === 'drafts' && this.hasStore,
  } as DOMStringList;
  private hasStore = false;

  createObjectStore(_name: string, _options: IDBObjectStoreParameters): FakeObjectStore {
    this.hasStore = true;
    return new FakeObjectStore(this.records);
  }

  transaction(_name: string, _mode: IDBTransactionMode): { objectStore: () => FakeObjectStore } {
    return {
      objectStore: () => new FakeObjectStore(this.records),
    };
  }
}

class FakeIndexedDB {
  readonly db = new FakeDatabase();

  open(_name: string, _version?: number): IDBOpenDBRequest {
    const request = {
      result: this.db,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    } as unknown as IDBOpenDBRequest;
    queueMicrotask(() => {
      request.onupgradeneeded?.({ target: request } as unknown as IDBVersionChangeEvent);
      request.onsuccess?.({ target: request } as unknown as Event);
    });
    return request;
  }
}

function fakeRequest<T>(result: T): IDBRequest<T> {
  const request = {
    result,
    error: null,
    onsuccess: null,
    onerror: null,
  } as IDBRequest<T>;
  queueMicrotask(() => request.onsuccess?.({ target: request } as unknown as Event));
  return request;
}

describe('ComposerDraftService', () => {
  let originalIndexedDb: IDBFactory | undefined;
  let fakeIndexedDb: FakeIndexedDB;

  const image = (): ComposerImageAttachment => ({
    id: 'img-1',
    name: 'screen.png',
    mediaType: 'image/png',
    dataUrl: 'data:image/png;base64,abc',
    size: 3,
  });

  beforeEach(() => {
    originalIndexedDb = globalThis.indexedDB;
    fakeIndexedDb = new FakeIndexedDB();
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: fakeIndexedDb,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: originalIndexedDb,
    });
  });

  it('saves and loads text, diff mentions, and image attachments by session', async () => {
    const service = new ComposerDraftService();
    const diffMention: DiffSelectionMention = {
      id: 'mention-1',
      version: 1,
      scope: 'branch',
      compareLabel: 'feature vs main',
      baseSha: 'base',
      headSha: 'head',
      filePath: 'src/app.ts',
      oldPath: null,
      status: 'modified',
      changeHash: 'hash',
      oldLineStart: 1,
      oldLineEnd: 1,
      newLineStart: 2,
      newLineEnd: 2,
      selectedText: 'const value = true;',
      context: { before: [], selected: [], after: [] },
      truncated: false,
    };

    await service.save({
      sessionId: 7,
      text: 'Keep this draft',
      diffMentions: [diffMention],
      images: [image()],
    });

    await expect(service.load(8)).resolves.toBeNull();
    await expect(service.load(7)).resolves.toEqual(
      expect.objectContaining({
        version: 1,
        sessionId: 7,
        text: 'Keep this draft',
        diffMentions: [diffMention],
        images: [image()],
        updatedAt: expect.any(String),
      }),
    );
  });

  it('deletes empty drafts and explicit deletes', async () => {
    const service = new ComposerDraftService();

    await service.save({ sessionId: 7, text: 'Draft', diffMentions: [], images: [] });
    await expect(service.load(7)).resolves.not.toBeNull();

    await service.save({ sessionId: 7, text: '   ', diffMentions: [], images: [] });
    await expect(service.load(7)).resolves.toBeNull();

    await service.save({ sessionId: 7, text: 'Draft again', diffMentions: [], images: [] });
    await service.delete(7);
    await expect(service.load(7)).resolves.toBeNull();
  });

  it('drops malformed stored data', async () => {
    const service = new ComposerDraftService();
    fakeIndexedDb.db.records.set(7, { version: 1, sessionId: 7, text: 123 });

    await expect(service.load(7)).resolves.toBeNull();
    expect(fakeIndexedDb.db.records.has(7)).toBe(false);
  });

  it('continues without throwing when IndexedDB is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: undefined,
    });
    const service = new ComposerDraftService();

    await expect(
      service.save({ sessionId: 7, text: 'Draft', diffMentions: [], images: [image()] }),
    ).resolves.toBeUndefined();
    await expect(service.load(7)).resolves.toBeNull();
    await expect(service.delete(7)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
