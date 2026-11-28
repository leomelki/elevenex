import { createHash, randomUUID } from 'node:crypto';
import type { SessionChatEvent, SessionChatItem } from '@elevenex/shared';

const CHECKPOINT_LIMIT = 64;
const RECORD_LIMIT = 8192;

interface LiveRecord {
  readonly id: string;
  readonly fieldsHash: string;
  readonly textHash: string;
  readonly textLength: number;
}

interface Checkpoint {
  readonly historyRevision: number;
  readonly sourceFirst: string | undefined;
  readonly sourceLength: number;
  readonly records: readonly LiveRecord[];
  readonly saved?: { readonly ids: ReadonlySet<string>; readonly afterLive: boolean };
}

function digest(value: string): string {
  // UTF-16 preserves exact JS code units when a provider splits a surrogate pair.
  return createHash('sha256').update(value, 'utf16le').digest('base64');
}

/** Retain only fingerprints of delivered windows. Resuming compares the
 * acknowledged window with the provider's current live tail, even if nobody
 * was connected when it changed. Multiple windows can consume independently. */
export class DesktopChatReplay {
  private readonly id = randomUUID();
  private sequence = 0;
  private records = 0;
  private readonly checkpoints = new Map<string, Checkpoint>();

  checkpoint(cursor: string | undefined, historyRevision: number): Checkpoint | undefined {
    const checkpoint = cursor && this.checkpoints.get(cursor);
    return checkpoint && checkpoint.historyRevision === historyRevision ? checkpoint : undefined;
  }

  describe(
    historyRevision: number,
    source: { readonly first: string | undefined; readonly length: number },
    items: readonly SessionChatItem[],
    previous?: Checkpoint,
    snapshot?: readonly SessionChatItem[],
  ): Checkpoint {
    const known = new Map(previous?.records.map(record => [record.id, record]));
    const records = items.map(({ text, ...fields }) => {
      const fieldsHash = digest(JSON.stringify(fields));
      const textHash = digest(text);
      const old = known.get(fields.id);
      return old?.fieldsHash === fieldsHash && old.textHash === textHash ? old
        : { id: fields.id, fieldsHash, textHash, textLength: text.length };
    });
    const liveIds = snapshot && new Set(records.map(record => record.id));
    const saved = snapshot && liveIds ? {
      ids: new Set(snapshot.filter(item => !liveIds.has(item.id)).map(item => item.id)),
      afterLive: records.length > 0 && records.at(-1)?.id !== snapshot.at(-1)?.id,
    } : previous?.saved;
    return { historyRevision, sourceFirst: source.first, sourceLength: source.length, records, saved };
  }

  updates(
    previous: Checkpoint,
    next: Checkpoint,
    items: readonly SessionChatItem[],
    clipped: boolean,
    appendText = true,
  ): readonly SessionChatEvent[] | undefined {
    if (previous.sourceLength > next.sourceLength ||
        (previous.sourceFirst !== undefined && previous.sourceFirst !== next.sourceFirst))
      return;
    const old = previous.records;
    const current = next.records;
    if (old.length === 0) {
      if (!current.length && previous.sourceLength === next.sourceLength) return [];
      // With no overlap, a clipped live page could skip rows between the
      // previous saved tail and these new items.
      if (clipped || previous.sourceLength > 0 || current.some(record => previous.saved?.ids.has(record.id))) return;
      return items.map(item => ({ type: 'item', item }));
    }

    const anchor = old.at(-1)?.id;
    const currentEnd = current.findIndex(record => record.id === anchor);
    if (currentEnd < 0) return;
    const overlap = Math.min(currentEnd + 1, old.length);
    const start = currentEnd + 1 - overlap;
    const oldStart = old.length - overlap;
    if (oldStart && !clipped) return;
    const appended = current.slice(currentEnd + 1);
    const oldIds = new Set(old.slice(0, oldStart).map(record => record.id));
    if (appended.length && (previous.saved?.afterLive ||
        appended.some(record => oldIds.has(record.id) || previous.saved?.ids.has(record.id))))
      return;
    const events: SessionChatEvent[] = [];
    for (let index = start; index < current.length; index++) {
      const record = current[index];
      const item = items[index];
      const prior = index <= currentEnd ? old[oldStart + index - start] : undefined;
      // An insertion, deletion or reorder inside the overlap needs an
      // authoritative window. Appending such rows would change turn ownership.
      if (prior && prior.id !== record.id) return;
      if (prior === record || (prior?.fieldsHash === record.fieldsHash && prior.textHash === record.textHash)) continue;
      if (appendText && prior?.fieldsHash === record.fieldsHash &&
          record.textLength > prior.textLength &&
          digest(item.text.slice(0, prior.textLength)) === prior.textHash) {
        events.push({ type: 'delta', id: record.id, text: item.text.slice(prior.textLength) });
      } else {
        events.push({ type: 'item', item });
      }
    }
    return events;
  }

  remember(checkpoint: Checkpoint, cursor = `${this.id}:${++this.sequence}:${checkpoint.historyRevision}`): string {
    const size = (value: Checkpoint) => value.records.length + (value.saved?.ids.size ?? 0);
    const previous = this.checkpoints.get(cursor);
    if (previous) this.records -= size(previous);
    this.checkpoints.set(cursor, checkpoint);
    this.records += size(checkpoint);
    for (const [id, previous] of this.checkpoints) {
      if (this.checkpoints.size <= CHECKPOINT_LIMIT && this.records <= RECORD_LIMIT) break;
      this.checkpoints.delete(id);
      this.records -= size(previous);
    }
    return cursor;
  }
}
