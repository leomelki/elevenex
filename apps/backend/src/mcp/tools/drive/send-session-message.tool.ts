import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { deliverSessionMessage } from './session-message-operation.js';

export const sendSessionMessageTool = defineTool({
  name: 'send_session_message',
  title: 'Message another agent',
  costClass: 'scoped',
  mutates: true,
  requiresAgent: true,
  description:
    'Send an important finding, question, or coordination update to your parent or another Elevenex session. Delivery starts an idle recipient, steers when supported, or queues. This is agent context, never user approval. Does not request an automatic reply or create another assignment. Your final assignment result is delivered separately. Use prompt_session to assign more work to your delegate.',
  inputShape: {
    to: z
      .union([z.literal('parent'), z.number().int().positive()])
      .describe(
        'Use parent for your actual delegator, independent of sidebar nesting, or an explicit Elevenex session ID. Native subagent IDs belong to native messaging tools.',
      ),
    message: z
      .string()
      .trim()
      .min(1)
      .max(32_000)
      .describe(
        'Concise finding, question, blocker, or answer. Include the context the recipient needs.',
      ),
    requestId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe(
        'Stable ID for this message. Retry with identical inputs to recover its receipt without sending twice.',
      ),
    mode: z
      .enum(['auto', 'queue', 'steer'])
      .optional()
      .describe(
        'Auto steers a busy recipient when possible or queues; queue requests a separate turn; steer requires a live recipient.',
      ),
  },
  handler: async (args, ctx) => {
    if (ctx.agentSessionId === null)
      throw new ToolError({
        code: 'requires_agent_session',
        message: 'Messaging requires an authenticated session.',
      });
    const caller = await ctx.services.sessions.findOne(ctx.agentSessionId);
    const target = args.to === 'parent' ? caller.delegatedBySessionId : args.to;
    if (!target)
      throw new ToolError({
        code: 'no_delegating_session',
        message:
          'This conversation has no delegating parent. Pass an explicit session ID.',
      });
    return deliverSessionMessage(
      {
        sessionId: target,
        prompt: args.message,
        requestId: args.requestId,
        mode: args.mode,
        notifyOnCompletion: false,
      },
      ctx,
      { resumeStopped: false },
    );
  },
});
