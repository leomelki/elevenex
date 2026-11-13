import type {
  ClaudeApiRetry,
  ClaudeCompactBoundary,
  ClaudeNotification,
} from '../claude-runtime/claude-runtime.types.js';
import type { PiSessionRuntimeEvent } from './pi-runtime.types.js';

export interface PiActivity {
  retry: ClaudeApiRetry | null;
  compact: ClaudeCompactBoundary | null;
  notifications: ClaudeNotification[];
}
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
const text = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, 1000) : '';
/** Native RPC events; supports older auto_compaction names as well as current compaction events. */
export function applyPiActivity(
  activity: PiActivity,
  event: PiSessionRuntimeEvent,
): boolean {
  const timestamp = new Date().toISOString();
  const notify = (key: string, message: string, high = false) => {
    activity.notifications = [
      ...activity.notifications.filter((note) => note.key !== key),
      {
        key,
        text: message,
        priority: high ? ('high' as const) : ('low' as const),
        timestamp,
      },
    ].slice(-8);
  };
  switch (event.type) {
    case 'auto_retry_start':
    case 'summarization_retry_scheduled':
      activity.retry = {
        attempt: count(event.attempt) ?? 0,
        maxRetries: count(event.maxAttempts) ?? 0,
        retryDelayMs: count(event.delayMs) ?? 0,
        errorStatus: null,
        error: text(event.errorMessage),
        timestamp,
      };
      return true;
    case 'auto_retry_end':
    case 'summarization_retry_finished':
      activity.retry = null;
      if (event.success === false)
        notify(
          'retry-failed',
          text(event.finalError) || 'Automatic retries exhausted',
          true,
        );
      return true;
    case 'compaction_start':
    case 'auto_compaction_start':
      notify('compacting', 'Compacting context');
      return true;
    case 'compaction_end':
    case 'auto_compaction_end': {
      activity.notifications = activity.notifications.filter(
        (note) => note.key !== 'compacting',
      );
      if (event.aborted === true) {
        notify('compaction', 'Context compaction interrupted');
        return true;
      }
      const result =
        event.result && typeof event.result === 'object'
          ? (event.result as Record<string, unknown>)
          : {};
      if (!event.result) {
        notify(
          'compaction',
          text(event.errorMessage) || 'Context compaction failed',
          true,
        );
        return true;
      }
      const before = count(result.tokensBefore),
        after = count(result.estimatedTokensAfter);
      if (before !== undefined)
        activity.compact = {
          trigger: event.reason === 'manual' ? 'manual' : 'auto',
          preTokens: before,
          ...(after !== undefined ? { postTokens: after } : {}),
          timestamp,
        };
      else notify('compaction', 'Context compacted');
      return true;
    }
    default:
      return false;
  }
}
