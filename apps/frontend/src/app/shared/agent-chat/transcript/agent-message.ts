import { agentReferenceLabel } from '@/shared/agent-tools/agent-label';
import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';

/** Only system entries may be interpreted as provider envelopes; quoted user text stays intact. */
export function incomingAgentMessage(
  item: AgentTranscriptItem,
): AgentTranscriptItem['agentMessage'] | null {
  if (item.kind !== 'system') return null;
  if (item.agentMessage) return item.agentMessage;
  const content = item.content?.trim() ?? '';
  const envelope = content.match(
    /^Message Type: (MESSAGE|FINAL_ANSWER)\s*\r?\nTask name: ([^\r\n]+)\s*\r?\nSender: ([^\r\n]+)\s*\r?\nPayload:?\s*(?:\r?\n([\s\S]*))?$/,
  );
  if (envelope) {
    const body = envelope[4]?.trim();
    return {
      sender: envelope[3].trim(),
      recipient: envelope[2].trim(),
      messageType: envelope[1] === 'FINAL_ANSWER' ? 'result' : 'message',
      body,
      bodyUnavailable: !body,
    };
  }
  // Compatibility with normalized Claude hand-backs and older Codex history.
  const received = content.match(
    /^Received (a final response|a message) from ([^\n]+?)\.(?:\n\n([\s\S]*)| (The message body (?:was not included|is unavailable)[\s\S]*))$/,
  );
  if (!received) return null;
  const body = received[3]?.replace(/^\[Subagent hand-back\]\s*/, '').trim();
  return {
    sender: received[2],
    messageType: received[1] === 'a final response' ? 'result' : 'message',
    body,
    bodyUnavailable: !body,
  };
}

export function agentRouteLabel(path: string): string {
  if (path === '/root') return 'Coordinator';
  if (/^[\da-f-]{16,}$/i.test(path)) return path;
  return agentReferenceLabel(path);
}
