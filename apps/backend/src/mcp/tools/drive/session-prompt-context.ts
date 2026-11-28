import { z } from 'zod';
import { serializeSessionMention } from '../../../agent-runtime/session-mention.js';
import { ToolError, type ToolContext } from '../../tool-registry/tool.types.js';
import { resolveSessionProvider } from './provider.util.js';

export const sessionMentionIds = z.array(z.number().int().positive()).max(10).optional().describe(
  'Attach chat-style context from up to 10 previous sessions. Select only relevant sessions. The target and orchestration missions cannot be mentioned.',
);

export async function attachSessionMentions(
  prompt: string,
  mentionSessionIds: readonly number[],
  ctx: ToolContext,
  targetSessionId: number,
): Promise<string> {
  // Validate all references before exporting history or starting the target.
  for (const sessionId of mentionSessionIds) {
    ctx.signal.throwIfAborted();
    if (sessionId === targetSessionId) {
      throw new ToolError({
        code: 'invalid_session_mention',
        message: 'A session cannot mention itself in its own prompt.',
        remediation:
          'Mention previous sessions, or omit mentionSessionIds to continue this session.',
      });
    }
    await resolveSessionProvider(ctx, sessionId);
  }
  const mentions: string[] = [];
  for (const sessionId of mentionSessionIds) {
    ctx.signal.throwIfAborted();
    try {
      const mention =
        await ctx.services.conversationExport.buildMention(sessionId);
      ctx.signal.throwIfAborted();
      mentions.push(serializeSessionMention(mention));
    } catch (error) {
      ctx.signal.throwIfAborted();
      throw new ToolError({
        code: 'session_mention_failed',
        message: `Could not build context for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        remediation:
          'Read the source with read_session or ask_session and pass its relevant findings in prompt, or retry the mention when its history is available.',
        retryable: true,
      });
    }
  }
  return mentions.length ? [prompt, ...mentions].join('\n\n') : prompt;
}
