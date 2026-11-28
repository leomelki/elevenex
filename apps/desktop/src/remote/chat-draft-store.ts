import { readFile, stat } from 'node:fs/promises';
import { isSessionChatDeliveryId, SESSION_CHAT_RETAINED_SEND_LIMIT } from '@elevenex/shared';
import type { SessionChatDraftEdit, SessionChatDraftTarget, SessionChatDraftText } from '@elevenex/shared';
import { AtomicJsonFile } from '../atomic-json-file';
import { object } from './validation';

const maxBytes = 16 * 1024 * 1024;
const maxDrafts = 512;
const header = '{"version":1,"drafts":[';
const footer = ']}';
const empty: SessionChatDraftText = { text: '' };

interface DraftScope {
  readonly slot: number;
  readonly identity: string;
}

interface SavedDraft extends DraftScope {
  readonly target: SessionChatDraftTarget;
  readonly draft: SessionChatDraftText;
}

function resourceId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid chat draft target.');
  return value;
}

export function draftTarget(value: unknown): SessionChatDraftTarget {
  const { taskId, sessionId } = object(value, ['taskId', 'sessionId']);
  return { taskId: resourceId(taskId), sessionId: sessionId === null ? null : resourceId(sessionId) };
}

function draftText(value: unknown): SessionChatDraftText {
  const { text, checkDelivery, pending, retained } = object(value, ['text', 'checkDelivery', 'pending', 'retained']);
  if (typeof text !== 'string' || text.length > 256_000 ||
      (checkDelivery !== undefined && (checkDelivery !== true || !text || pending !== undefined || retained !== undefined))) {
    throw new Error('Invalid chat draft text or draft exceeds its size limit.');
  }
  const ids = new Set<string | null>();
  const parsedPending = pending === undefined ? undefined : (() => {
    const { id, text: submitted } = object(pending, ['id', 'text']);
    if (!isSessionChatDeliveryId(id) || typeof submitted !== 'string' ||
        submitted.length > 64_000 || text.length + submitted.length > 256_000)
      throw new Error('Invalid pending conversation delivery.');
    ids.add(id);
    return { id, text: submitted };
  })();
  if (retained !== undefined && (!Array.isArray(retained) || retained.length + Number(!!parsedPending) > SESSION_CHAT_RETAINED_SEND_LIMIT))
    throw new Error('Invalid retained conversation deliveries.');
  const parsedRetained = Array.isArray(retained) ? retained.map(value => {
    const { id, text: submitted, rejected } = object(value, ['id', 'text', 'rejected']);
    if ((id !== null && !isSessionChatDeliveryId(id)) || ids.has(id) || typeof submitted !== 'string' ||
        submitted.length > (id === null ? 256_000 : 64_000) ||
        (rejected !== undefined && (rejected !== true || id === null)))
      throw new Error('Invalid retained conversation delivery.');
    ids.add(id);
    return { id, text: submitted, ...(rejected === true ? { rejected: true as const } : {}) };
  }) : [];
  return {
    text, ...(checkDelivery === true ? { checkDelivery } : {}),
    ...(parsedPending ? { pending: parsedPending } : {}),
    ...(parsedRetained.length ? { retained: parsedRetained } : {}),
  };
}

export function draftEdit(value: unknown): SessionChatDraftEdit {
  const { target, draft, fromCreation } = object(value, ['target', 'draft', 'fromCreation']);
  const parsed = draftTarget(target);
  if (fromCreation !== undefined && (fromCreation !== true || parsed.sessionId === null)) throw new Error('Invalid chat draft move.');
  return { target: parsed, draft: draftText(draft), ...(fromCreation === true ? { fromCreation } : {}) };
}

function key({ slot, identity }: DraftScope, { taskId, sessionId }: SessionChatDraftTarget): string {
  return `${slot}/${identity}/${taskId}/${sessionId}`;
}

/** One private sidecar. Edits replace a single entry and share a short disk-write batch. */
export class ChatDraftStore {
  private readonly records = new Map<string, { readonly draft: SessionChatDraftText; readonly body: string; readonly bytes: number }>();
  private bytes = header.length + footer.length;
  private unavailable = false;
  private readonly writer: AtomicJsonFile;
  private pending?: { readonly promise: Promise<void>; resolve(): void; reject(error: unknown): void };
  private active = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly path: string) {
    this.writer = new AtomicJsonFile(path, maxBytes, true);
  }

  async load(): Promise<void> {
    try {
      if ((await stat(this.path)).size > maxBytes) throw new Error('Chat drafts exceed their storage limit.');
      const { version, drafts } = object(JSON.parse(await readFile(this.path, 'utf8')), ['version', 'drafts']);
      if (version !== 1 || !Array.isArray(drafts) || drafts.length > maxDrafts) throw new Error('Invalid chat draft file.');
      for (const value of drafts) {
        const { slot, identity, target, draft } = object(value, ['slot', 'identity', 'target', 'draft']);
        if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= 32 ||
            typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity)) throw new Error('Invalid chat draft scope.');
        const saved: SavedDraft = { slot, identity, target: draftTarget(target), draft: draftText(draft) };
        const id = key(saved, saved.target), record = this.record(saved);
        if ((!record.draft.text && !record.draft.pending && !record.draft.retained?.length) || this.records.has(id)) throw new Error('Invalid saved chat draft.');
        this.records.set(id, record);
        this.bytes += record.bytes;
      }
      if (this.bytes > maxBytes) throw new Error('Chat drafts exceed their storage limit.');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      // Keep a damaged or newer file intact and keep chat usable in memory.
      this.records.clear();
      this.unavailable = true;
    }
  }

  read(scope: DraftScope, target: SessionChatDraftTarget): SessionChatDraftText {
    this.assertAvailable();
    return this.records.get(key(scope, target))?.draft ?? empty;
  }

  save(scope: DraftScope, { target, draft, fromCreation }: SessionChatDraftEdit): Promise<void> {
    this.assertAvailable();
    const id = key(scope, target);
    const source = fromCreation ? key(scope, { taskId: target.taskId, sessionId: null }) : undefined;
    const previous = this.records.get(id);
    const moved = source ? this.records.get(source) : undefined;
    const next = draft.text || draft.pending || draft.retained?.length ? this.record({ ...scope, target, draft }) : undefined;
    const bytes = this.bytes - (previous?.bytes ?? 0) - (moved?.bytes ?? 0) + (next?.bytes ?? 0);
    const count = this.records.size - Number(!!previous) - Number(!!moved) + Number(!!next);
    if (bytes > maxBytes || count > maxDrafts) throw new Error('Chat drafts exceed their local storage limit.');
    if (next) this.records.set(id, next);
    else this.records.delete(id);
    if (source) this.records.delete(source);
    this.bytes = bytes;
    if (!this.pending) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
      this.pending = { promise, resolve, reject };
      this.timer = setTimeout(() => { void this.flush(); }, 250);
    }
    return this.pending.promise;
  }

  /** Shutdown drains text already handed to main, including a just-typed edit. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    const pending = this.pending;
    if (pending) {
      this.pending = undefined;
      const body = header + [...this.records.values()].map(record => record.body).join(',') + footer;
      this.active = this.writer.write(body);
      void this.active.then(pending.resolve, pending.reject);
    }
    return this.active;
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new Error('The local chat draft file could not be read.');
  }

  private record(value: SavedDraft) {
    const body = JSON.stringify(value);
    return { draft: value.draft, body, bytes: Buffer.byteLength(body) + 1 };
  }
}
