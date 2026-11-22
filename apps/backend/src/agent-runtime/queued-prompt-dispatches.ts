import type { AgentTranscriptItem } from './agent-runtime.types.js';

interface RuntimeTranscript {
  readonly liveItems: readonly AgentTranscriptItem[];
}

export interface QueuedPromptDispatch {
  readonly id: string;
  readonly prompt: string;
  readonly timestamp: string;
}

interface Dispatch extends QueuedPromptDispatch {
  readonly existingUsers: Set<string>;
}

/** Track queue handoffs until the harness publishes its own transcript item. */
export class QueuedPromptDispatches {
  private readonly pending = new WeakMap<RuntimeTranscript, Dispatch[]>();

  begin(state: RuntimeTranscript, prompt: { id: string; prompt: string }): () => boolean {
    const dispatch = {
      id: prompt.id,
      prompt: prompt.prompt,
      timestamp: new Date().toISOString(),
      existingUsers: new Set(state.liveItems.filter(item => item.kind === 'user').map(item => item.id)),
    };
    const pending = this.pending.get(state) ?? [];
    this.pending.set(state, [...pending.filter(item => item.id !== prompt.id), dispatch].slice(-8));
    return () => {
      const current = this.pending.get(state);
      if (!current?.includes(dispatch)) return false;
      this.pending.set(state, current.filter(item => item !== dispatch));
      return true;
    };
  }

  current(state: RuntimeTranscript): readonly QueuedPromptDispatch[] {
    const pending = this.pending.get(state);
    if (!pending?.length) return [];
    // Matching is ordered and one-to-one, including repeated prompt text.
    const claimed = new Set<string>();
    const remaining = pending.filter(dispatch => {
      const receipt = state.liveItems.find(item => item.kind === 'user' &&
        !dispatch.existingUsers.has(item.id) && !claimed.has(item.id) &&
        item.content?.trim() === dispatch.prompt.trim());
      if (!receipt) return true;
      claimed.add(receipt.id);
      return false;
    });
    if (remaining.length !== pending.length) {
      // A later read must not match a second identical dispatch to the same receipt.
      for (const dispatch of remaining)
        for (const id of claimed) dispatch.existingUsers.add(id);
      this.pending.set(state, remaining);
    }
    return remaining.map(({ id, prompt, timestamp }) => ({ id, prompt, timestamp }));
  }

  clear(state: RuntimeTranscript): void {
    this.pending.delete(state);
  }
}
