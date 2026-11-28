import { signal } from '@angular/core';
import type { ElevenexBridge, EnvironmentSelection, SessionChatDraftTarget, SessionChatRetainedSend } from '@elevenex/shared';
import type { ConversationAttachment, ConversationMention } from '../conversation';

export interface AttachmentDraft extends ConversationAttachment { readonly file: File }

interface DraftBinding {
  readonly bridge: Pick<ElevenexBridge, 'sessionChatDraftRead' | 'sessionChatDraftSave'>;
  readonly environment: EnvironmentSelection;
  readonly current: () => boolean;
  readonly readTarget: SessionChatDraftTarget;
  target: SessionChatDraftTarget;
  identity?: string;
  fromCreation?: true;
}

function prepend(first: string, rest: string): string {
  return first && rest ? first + '\n\n' + rest : first || rest;
}

interface SubmissionContext {
  readonly files?: readonly AttachmentDraft[];
  readonly mentions?: readonly ConversationMention[];
}

/** One composer entry. Files and mention chips retain their window lifetime. */
export class SessionDraft {
  private readonly value = signal('');
  readonly text = this.value.asReadonly();
  readonly uncertain = signal('');
  readonly files = signal<readonly AttachmentDraft[]>([]);
  readonly mentions = signal<readonly ConversationMention[]>([]);
  private readonly failure = signal('');
  private readonly readingState = signal(false);
  readonly error = this.failure.asReadonly();
  readonly restoring = this.readingState.asReadonly();
  private binding?: DraftBinding;
  private reading?: Promise<void>;
  private dirty = false;
  private discarded = false;
  private revision = 0;
  private readonly submission = signal<{
    readonly id: string; readonly text: string;
    readonly checking: boolean;
  } & SubmissionContext | null>(null);
  readonly delivery = this.submission.asReadonly();
  private readonly retainedSends = signal<readonly (SessionChatRetainedSend & SubmissionContext)[]>([]);
  readonly retained = this.retainedSends.asReadonly();

  bind(binding: DraftBinding): void {
    this.binding = binding;
    void this.restore(binding);
  }

  setText(text: string): void {
    if (this.text() === text) return;
    this.value.set(text);
    this.changed();
  }

  beginSend(id: string, text: string, original: string): { consumed: boolean; saved?: Promise<boolean> } {
    const consumed = this.text() === original;
    this.submission.set({
      id, text: original.trim() === text.trim() ? original : text,
      files: this.files(), mentions: this.mentions(), checking: false,
    });
    if (consumed) this.value.set('');
    this.files.set([]);
    this.mentions.set([]);
    const saved = this.changed();
    return { consumed, saved };
  }

  checkSend(id: string): void {
    const send = this.submission();
    if (send?.id === id && !send.checking) this.submission.set({ ...send, checking: true });
  }

  finishSend(id: string, restore: boolean): boolean {
    const send = this.submission();
    if (send?.id !== id) return false;
    this.submission.set(null);
    if (restore) this.restoreContent(send);
    this.changed();
    return true;
  }

  retainSend(id: string): void {
    const send = this.submission();
    if (send?.id !== id || !send.checking) return;
    const { text, files, mentions } = send;
    this.retainedSends.update(items => [...items, { id, text, files, mentions }]);
    this.submission.set(null);
    this.changed();
  }

  reconcileRetained(id: string, rejected: boolean): void {
    this.retainedSends.update(items => rejected
      ? items.map(item => item.id === id ? { ...item, rejected: true as const } : item)
      : items.filter(item => item.id !== id));
    this.changed();
  }

  removeRetained(id: string | null, restore = false): void {
    const item = this.retained().find(item => item.id === id);
    if (!item || (restore && !item.rejected)) return;
    this.retainedSends.update(items => items.filter(item => item.id !== id));
    if (restore) this.restoreContent(item);
    this.changed();
  }

  private restoreContent({ text, files, mentions }: { readonly text: string } & SubmissionContext): void {
    this.value.update(current => prepend(text, current));
    if (files?.length) this.files.update(current => [...files, ...current]);
    if (mentions?.length) this.mentions.update(current => [...mentions.filter(item => !current.some(mention => mention.id === item.id)), ...current]);
  }

  discard(): void {
    this.discarded = true;
    this.submission.set(null);
    this.retainedSends.set([]);
    this.value.set('');
    this.changed();
  }

  promote(target: SessionChatDraftTarget): void {
    const binding = this.binding;
    if (!binding) return;
    binding.target = target;
    // The creation read may still be pending when its backend reply arrives.
    // Its result belongs to the same composer and moves with it.
    if (this.text() || this.dirty || !binding.identity) {
      binding.fromCreation = true;
      this.changed();
    }
  }

  mergeCreation(source: SessionDraft): void {
    // A navigation read can expose the saved session before the create reply.
    // Preserve its existing entry, including attachments and unresolved sends.
    const merge = () => {
      if (!source.text() || (this.binding && !this.binding.current())) return;
      if (this.binding) this.binding.fromCreation = true;
      this.value.update(text => prepend(source.text(), text));
      this.changed();
    };
    if (source.reading) void source.reading.then(merge);
    else merge();
  }

  retry(): void {
    const binding = this.binding;
    if (!binding?.current()) return;
    if (binding.identity) void this.save(binding);
    else void this.restore(binding);
  }

  hasUnsavedText(): boolean {
    return !!this.binding && this.dirty;
  }

  private changed(): Promise<boolean> | undefined {
    this.dirty = true;
    if (!this.binding) return;
    return this.binding.identity ? this.save(this.binding) : Promise.resolve(false);
  }

  private restore(binding: DraftBinding): Promise<void> {
    if (this.reading) return this.reading;
    this.readingState.set(true);
    this.reading = (async () => {
      try {
        const { identity, draft } = await binding.bridge.sessionChatDraftRead(binding.environment, binding.readTarget);
        if (!binding.current()) return;
        binding.identity = identity;
        this.failure.set('');
        if (!this.discarded) {
          // Edits can start while the local read is pending. Keep both pieces
          // of writing if the editor already contains newer text.
          const text = draft.checkDelivery ? '' : draft.text;
          if (text && text !== this.text()) this.value.update(current => prepend(text, current));
          const retained = draft.retained ?? [];
          this.retainedSends.set(draft.checkDelivery ? [{ id: null, text: draft.text }]
            : draft.pending ? [...retained, draft.pending] : retained);
          if (draft.checkDelivery || draft.pending) this.dirty = true;
        }
        if (this.dirty) void this.save(binding);
      } catch {
        if (binding.current()) this.failure.set('Could not restore the local chat draft.');
      } finally {
        this.reading = undefined;
        this.readingState.set(false);
      }
    })();
    return this.reading;
  }

  private async save(binding: DraftBinding): Promise<boolean> {
    const { identity, target, fromCreation } = binding;
    if (!identity || !binding.current()) return false;
    const revision = ++this.revision;
    const text = this.text();
    const submission = this.submission();
    const retained = this.retained().map(({ id, text, rejected }) => ({ id, text, ...(rejected ? { rejected } : {}) }));
    const draft = {
      text,
      ...(submission ? { pending: { id: submission.id, text: submission.text } } : {}),
      ...(retained.length ? { retained } : {}),
    };
    // Offer the move only once. A subsequent creation in the same task may
    // already have a new draft by the time this write is acknowledged.
    binding.fromCreation = undefined;
    try {
      await binding.bridge.sessionChatDraftSave(binding.environment, identity, {
        target, draft, ...(fromCreation ? { fromCreation } : {}),
      });
      if (binding.current() && revision === this.revision) {
        this.dirty = false;
        this.failure.set('');
      }
      return binding.current();
    } catch {
      if (binding.current() && revision === this.revision) this.failure.set('Could not save the chat draft on this device.');
      return false;
    }
  }
}
