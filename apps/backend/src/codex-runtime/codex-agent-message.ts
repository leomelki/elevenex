import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import { readableText, record, textValue } from './codex-subagents.js';

/** Incoming collaboration messages are distinct from the assistant's own agentMessage. */
export function codexAgentMessage(
  raw: Record<string, unknown>,
): Pick<ClaudeTranscriptItem, 'kind' | 'content' | 'agentMessage'> | null {
  const content =
    readableText(
      typeof raw.content === 'string'
        ? raw.content
        : Array.isArray(raw.content)
          ? raw.content
              .map((block) => textValue(record(block).text) ?? '')
              .filter(Boolean)
              .join('\n\n')
          : raw.text,
    ) ?? '';
  const envelope = content
    .trim()
    .match(
      /^Message Type: (MESSAGE|FINAL_ANSWER)\s*\r?\nTask name: ([^\r\n]+)\s*\r?\nSender: ([^\r\n]+)\s*\r?\nPayload:?\s*(?:\r?\n([\s\S]*))?$/,
    );
  const sender = textValue(raw.author) ?? envelope?.[3]?.trim();
  if (!sender) return null;
  const recipient = textValue(raw.recipient) ?? envelope?.[2]?.trim();
  const messageType = envelope?.[1] === 'FINAL_ANSWER' ? 'result' : 'message';
  const body = readableText(envelope ? envelope[4]?.trim() : content.trim());
  return {
    kind: 'system',
    content: body
      ? content
      : `Received ${messageType === 'result' ? 'a final response' : 'a message'} from ${sender}. The message body is unavailable in the saved transcript.`,
    agentMessage: {
      sender,
      recipient,
      messageType,
      body,
      bodyUnavailable: !body,
    },
  };
}
