import { signal } from '@angular/core';
import type { ElevenexBridge, EnvironmentSelection, SessionChatDraftTarget } from '@elevenex/shared';
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
  private pendingText = '';
  private checkDelivery = false;

  bind(binding: DraftBinding): void {
    this.binding = binding;
    void this.restore(binding);
  }

  setText(text: string): void {
    if (this.text() === text) return;
    this.value.set(text);
    this.changed();
  }

  beginSend(text: string, original: string): boolean {
    this.pendingText = original.trim() === text.trim() ? original : text;
    // Reading the latest history can delay submission while typing continues.
    const consumed = this.text() === original;
    if (consumed) this.value.set('');
    if (this.pendingText) this.changed();
    return consumed;
  }

  finishSend(restore: boolean): void {
    const pending = this.pendingText;
    this.pendingText = '';
    if (!pending) return;
    if (restore) this.value.update(text => prepend(pending, text));
    this.checkDelivery = restore && !!this.uncertain();
    this.changed();
  }

  acknowledgeSend(): void {
    this.uncertain.set('');
    if (!this.checkDelivery) return;
    this.checkDelivery = false;
    this.changed();
  }

  discard(): void {
    this.discarded = true;
    this.pendingText = '';
    this.checkDelivery = false;
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

  private changed(): void {
    this.dirty = true;
    if (this.binding?.identity) void this.save(this.binding);
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
          if (draft.text && draft.text !== this.text()) this.value.update(text => prepend(draft.text, text));
          if (draft.checkDelivery) {
            this.checkDelivery = true;
            this.uncertain.set('This message was in progress when the app closed. Check its delivery before sending again.');
          }
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

  private async save(binding: DraftBinding): Promise<void> {
    const { identity, target, fromCreation } = binding;
    if (!identity || !binding.current()) return;
    const revision = ++this.revision;
    const text = prepend(this.pendingText, this.text());
    const checkDelivery = !!text && (!!this.pendingText || this.checkDelivery);
    // Offer the move only once. A subsequent creation in the same task may
    // already have a new draft by the time this write is acknowledged.
    binding.fromCreation = undefined;
    try {
      await binding.bridge.sessionChatDraftSave(binding.environment, identity, {
        target, draft: { text, ...(checkDelivery ? { checkDelivery: true } : {}) }, ...(fromCreation ? { fromCreation } : {}),
      });
      if (binding.current() && revision === this.revision) {
        this.dirty = false;
        this.failure.set('');
      }
    } catch {
      if (binding.current() && revision === this.revision) this.failure.set('Could not save the chat draft on this device.');
    }
  }
}
