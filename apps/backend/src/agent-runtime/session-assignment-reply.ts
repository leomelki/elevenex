import type {
  AgentTranscriptItem,
  AgentPromptDisposition,
} from './agent-runtime.types.js';
import { latestConversationReply } from './conversation-export.service.js';
import { splitSessionAgentPrompt } from '../sessions/session-agent-message.js';

/** Queued assignments have separate results; steering shares the current assignment's result. */
export function sessionAssignmentReply(
  history: readonly AgentTranscriptItem[],
  messageId: string | null,
  dispositions: ReadonlyMap<string, AgentPromptDisposition | null>,
): AgentTranscriptItem | undefined {
  const start = messageId
    ? history.findIndex(
        (item) =>
          item.kind === 'user' &&
          splitSessionAgentPrompt(item.content ?? '').sender?.messageId ===
            messageId,
      )
    : -1;
  if (start < 0) return;
  let end = history.length;
  for (let index = start + 1; index < history.length; index++) {
    const item = history[index];
    if (item.kind !== 'user') continue;
    const sender = splitSessionAgentPrompt(item.content ?? '').sender;
    if (
      sender?.purpose === 'assignment' &&
      sender.messageId &&
      dispositions.get(sender.messageId) !== 'steered'
    ) {
      end = index;
      break;
    }
  }
  // Provider-generated user frames (images, tool continuations) do not start another assignment.
  return latestConversationReply([
    history[start],
    ...history.slice(start + 1, end).filter((item) => item.kind !== 'user'),
  ]);
}
