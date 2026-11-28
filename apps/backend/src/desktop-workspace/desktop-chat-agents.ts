import { BadRequestException } from '@nestjs/common';
import type { AgentRuntimeProvider } from '../agent-runtime/agent-runtime.types.js';
import { display, record } from './desktop-chat-projection.js';
import { chatWindow } from './desktop-chat-window.js';
import { agentContext, agentStatus } from './desktop-chat-work.js';

/** Cursor carries only provider message identities, never a transcript path. */
interface AgentCursor {
  before?: string;
  nativeBefore?: string;
  nativeThrough?: string;
}
export async function readChatAgent(
  provider: Pick<AgentRuntimeProvider, 'getSubagentHistory'>,
  sessionId: number,
  agentId: string,
  cursor?: string,
) {
  if (!/^[\w-]{1,256}$/.test(agentId) || !provider.getSubagentHistory)
    throw new BadRequestException('Agent history is unavailable.');
  let position: AgentCursor = {};
  if (cursor !== undefined) {
    try {
      if (cursor.length > 2000 || !/^[\w-]+$/.test(cursor)) throw new Error();
      const value: unknown = JSON.parse(
        Buffer.from(cursor, 'base64url').toString(),
      );
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error();
      const entry = record(value);
      for (const key of ['before', 'nativeBefore', 'nativeThrough'])
        if (
          entry[key] !== undefined &&
          (typeof entry[key] !== 'string' || entry[key].length > 500)
        )
          throw new Error();
      position = {
        ...(typeof entry.before === 'string' ? { before: entry.before } : {}),
        ...(typeof entry.nativeBefore === 'string'
          ? { nativeBefore: entry.nativeBefore }
          : {}),
        ...(typeof entry.nativeThrough === 'string'
          ? { nativeThrough: entry.nativeThrough }
          : {}),
      };
    } catch {
      throw new BadRequestException('Invalid agent history cursor.');
    }
  }
  // The provider verifies child ownership; do not accept a renderer-supplied path.
  const result = await provider.getSubagentHistory(sessionId, agentId, {
    before: position.nativeBefore,
    ...(position.nativeThrough ? { through: position.nativeThrough } : {}),
  });
  const agent = result.subagent;
  if (!agent || agent.agentId !== agentId)
    throw new BadRequestException('Agent identity changed.');
  // A repeated raw record must not come back on another page under the same ID.
  const history = [...new Map(result.history.map(item => [item.id, item])).values()];
  const window = chatWindow(history, [], {
    before: position.before, includeLeadingPrompt: false, linkToolReceipts: true,
  });
  if (!window)
    throw new BadRequestException(
      'Agent history changed. Refresh to read the latest messages.',
    );
  const nativeThrough = result.nativeWindow
    ? history.find(item => item.id === window.before)?.transcriptMessageId : undefined;
  const next: AgentCursor | null = window.before
    ? nativeThrough ? { before: window.before, nativeThrough } : { before: window.before, nativeBefore: position.nativeBefore }
    : result.hasEarlier && history[0]?.transcriptMessageId
      ? { nativeBefore: history[0].transcriptMessageId }
      : null;
  return {
    agentId,
    label: display(agent.displayName || agent.agentType, 240),
    ...(agent.taskTitle
      ? {
          title: display(agent.taskTitle, 120),
          ...(agent.displayName
            ? { agentName: display(agent.displayName, 160) }
            : {}),
          role: display(agent.agentType, 80),
        }
      : {}),
    status: agentStatus({ ...agent }),
    prompt: display(agent.prompt, 4000),
    model: agent.model ? display(agent.model, 160) : null,
    context: agentContext(agent.contextUsage) ?? null,
    // Child media needs its own confined resolver; retain text without forwarding unusable references.
    items: window.items.map((item) => {
      const projected = { ...item };
      delete projected.media;
      return projected;
    }),
    before: next
      ? Buffer.from(JSON.stringify(next)).toString('base64url')
      : null,
    availability:
      result.transcriptState === 'error'
        ? 'error'
        : window.items.length
          ? 'available'
          : result.transcriptState === 'starting' || agent.status === 'started'
            ? 'starting'
            : 'unavailable',
    message: display(result.transcriptError, 1000),
  };
}
