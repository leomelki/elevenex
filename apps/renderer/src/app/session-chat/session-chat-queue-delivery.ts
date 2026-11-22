import type { SessionChatItem, SessionChatState } from '@elevenex/shared';
import { pendingPromptStart, type PendingChatPrompt } from './session-chat-transcript';

export interface QueuedDelivery extends PendingChatPrompt {
  /** A click can precede the engine's dispatch update. */
  readonly local: boolean;
}

export function queuedDelivery(
  prompt: NonNullable<SessionChatState['dispatchingPrompts']>[number],
  previous: readonly SessionChatItem[], local: boolean,
): QueuedDelivery {
  return { ...prompt, id: `queued-delivery:${prompt.id}`, knownIds: new Set(previous.map(item => item.id)), local };
}

/** Promote only an explicit handoff or a new native receipt. Queue removal alone can be a cancellation. */
export function reconcileQueuedDeliveries(
  current: ReadonlyMap<string, QueuedDelivery>, state: SessionChatState,
  previous: readonly SessionChatItem[], records: readonly SessionChatItem[],
  incremental: boolean, claimedReceipts: ReadonlySet<string>,
): {
  readonly deliveries: ReadonlyMap<string, QueuedDelivery>;
  readonly arrivals: ReadonlyMap<string, string>;
  readonly records: readonly SessionChatItem[];
} {
  const arrivals = new Map<string, string>();
  const queued = new Set(state.queue.map(item => item.id));
  const dispatched = new Map(state.dispatchingPrompts?.map(item => [item.id, item]));
  const deliveries = new Map(current);
  for (const [id, prompt] of dispatched) {
    if (queued.has(id)) continue;
    const prior = deliveries.get(id);
    if (prior?.local) deliveries.set(id, { ...prior, text: prompt.text, media: prompt.media, mentions: prompt.mentions, local: false });
    else if (!prior) deliveries.set(id, queuedDelivery(prompt, previous.length ? previous : records, false));
  }
  for (const [id, delivery] of deliveries) {
    const start = pendingPromptStart(records, delivery);
    const index = queued.has(id) || dispatched.has(id) ? -1 : records.findIndex((item, index) =>
      index >= start && item.kind === 'user' && !delivery.knownIds.has(item.id) &&
      !arrivals.has(item.id) && !claimedReceipts.has(item.id) && item.text === delivery.text);
    const receipt = records[index];
    if (receipt) {
      arrivals.set(receipt.id, delivery.id);
      deliveries.delete(id);
      // Live output can beat the user receipt. Snapshots already carry saved order.
      if (incremental && index > start && !records.slice(start, index).some(item => item.kind === 'user')) {
        records = [...records.slice(0, start), receipt, ...records.slice(start, index), ...records.slice(index + 1)];
      }
    } else if (!dispatched.has(id) && (
      !delivery.local || state.phase === 'error' || (state.dispatchingPrompts !== undefined && !queued.has(id))
    )) {
      deliveries.delete(id);
    }
  }
  const unchanged = deliveries.size === current.size && [...deliveries].every(([id, delivery]) => current.get(id) === delivery);
  return { deliveries: unchanged ? current : deliveries, arrivals, records };
}
