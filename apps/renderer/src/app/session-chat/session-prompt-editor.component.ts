import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterRenderEffect, computed,
  inject, input, output, signal, viewChild,
} from '@angular/core';
import { SESSION_CHAT_PROMPT_LIMIT, type SessionChatPromptEdit } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { SessionChatClient } from '../backend/session-chat-client.service';
import { ButtonComponent, IconButtonComponent, IconComponent, ModalLayerComponent } from '../ui';
import { SessionChatStore, type ChatSelection } from './session-chat.store';

@Component({
  selector: 'ex-session-prompt-editor',
  imports: [ButtonComponent, IconButtonComponent, IconComponent, ModalLayerComponent],
  templateUrl: './session-prompt-editor.component.html',
  styleUrl: './session-prompt-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionPromptEditorComponent {
  readonly selection = input.required<ChatSelection>();
  readonly itemId = input.required<string>();
  readonly closed = output<boolean>();
  protected readonly open = signal(true);
  protected readonly preparing = signal(true);
  protected readonly saving = signal(false);
  protected readonly snapshot = signal<SessionChatPromptEdit | null>(null);
  protected readonly draft = signal('');
  protected readonly error = signal('');
  protected readonly checking = signal(false);
  protected readonly copied = signal(false);
  protected readonly limit = SESSION_CHAT_PROMPT_LIMIT;
  protected readonly store = inject(SessionChatStore);
  protected readonly canSave = computed(() => {
    const snapshot = this.snapshot(), draft = this.draft().trim();
    return this.open() && !!snapshot && !!draft && draft !== snapshot.text.trim() &&
      this.draft().length <= this.limit && !this.saving() && !this.checking() &&
      !this.store.promptEditDisabledReason();
  });
  private readonly client = inject(SessionChatClient);
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly editor = viewChild<ElementRef<HTMLTextAreaElement>>('editor');
  private request: { scopeId: string; requestId: string } | undefined;
  private destroyed = false;
  protected edited = false;

  constructor() {
    let started = false;
    afterRenderEffect(() => {
      if (!started) { started = true; void this.prepare(); }
    });
    afterRenderEffect(() => {
      const textarea = this.editor()?.nativeElement;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.cancelRead();
    });
  }

  protected async prepare(): Promise<void> {
    this.cancelRead();
    const { scopeId, taskId, sessionId } = this.selection();
    const request = { scopeId, requestId: crypto.randomUUID() };
    this.request = request;
    this.error.set('');
    this.preparing.set(true);
    const result = await this.client.promptEdit(scopeId, { taskId, sessionId, itemId: this.itemId(), requestId: request.requestId });
    if (this.request !== request) return;
    this.request = undefined;
    this.preparing.set(false);
    if (result.ok) {
      this.draft.set(result.value.text);
      this.snapshot.set(result.value);
    } else this.error.set(result.error.message);
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void this.save();
  }

  protected async save(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || !this.canSave()) return;
    this.saving.set(true);
    this.error.set('');
    this.copied.set(false);
    const accepted = await this.store.editPrompt(this.selection(), snapshot.itemId, snapshot.revision, this.draft());
    if (this.destroyed) return;
    this.saving.set(false);
    if (accepted) {
      this.edited = true;
      this.close();
    } else {
      this.checking.set(!!this.store.uncertain());
      this.error.set(this.store.promptEditError() || this.store.promptEditDisabledReason() || 'Could not resend the message.');
    }
  }

  protected async copyDraft(): Promise<void> {
    try {
      await this.bridge.writeClipboardText(this.draft());
      if (!this.destroyed) this.copied.set(true);
    } catch {
      if (!this.destroyed) this.error.set('Could not copy the draft. Select the text to copy it.');
    }
  }

  protected close(): void {
    if (this.saving()) return;
    this.cancelRead();
    this.open.set(false);
  }

  private cancelRead(): void {
    if (!this.request) return;
    this.client.cancel(this.request.scopeId, this.request.requestId);
    this.request = undefined;
  }
}
