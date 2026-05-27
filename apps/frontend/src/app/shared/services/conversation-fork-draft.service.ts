import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ConversationForkDraftService {
  private readonly drafts = new Map<number, string>();

  setDraft(sessionId: number, draft: string | null | undefined): void {
    const normalized = draft?.trim();
    if (!normalized) return;
    this.drafts.set(sessionId, draft ?? '');
  }

  consumeDraft(sessionId: number): string | null {
    const draft = this.drafts.get(sessionId);
    if (draft === undefined) return null;
    this.drafts.delete(sessionId);
    return draft;
  }
}
