import { Injectable } from '@angular/core';

/**
 * Carries a prompt from the place that creates an agent session (e.g. the
 * Cmd/Ctrl+K command bar) to the session workspace that hydrates moments later.
 *
 * The workspace component reads the queued prompt once it is hydrated and
 * submits it automatically, so a freshly created session immediately starts
 * working on the user's question without a manual second step.
 *
 * Keyed by session id so concurrent session creations never cross wires.
 */
@Injectable({ providedIn: 'root' })
export class PendingAgentPromptService {
  private readonly prompts = new Map<number, string>();

  set(sessionId: number, prompt: string): void {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }
    this.prompts.set(sessionId, trimmed);
  }

  /** Returns and clears the queued prompt for a session, if any. */
  take(sessionId: number): string | null {
    const prompt = this.prompts.get(sessionId);
    if (prompt === undefined) {
      return null;
    }
    this.prompts.delete(sessionId);
    return prompt;
  }
}
