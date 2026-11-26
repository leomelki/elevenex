import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { sessionMentionIds } from './session-prompt-context.js';
import { deliverSessionMessage } from './session-message-operation.js';

export const promptSessionTool = defineTool({
  name: 'prompt_session',
  title: 'Prompt session',
  costClass: 'heavy',
  mutates: true,
  description:
    'Send a follow-up to another session by ID. Starts an idle session, steers a live turn when supported, or queues. Use mode to explicitly queue, require live steering, or restart. Authenticated sends carry the sender session ID. Follow-ups to your own delegate report completion automatically. Reuse requestId for safe retries. Returns the delivery disposition or acceptance_pending after 5s. Use await_session_event for the result; do not resend an unconfirmed prompt.',
  disallowSelfTarget: 'session',
  inputShape: {
    sessionId: z
      .number()
      .int()
      .positive()
      .describe(
        'Session to prompt. Get ids from find_sessions / project_overview.',
      ),
    prompt: z
      .string()
      .trim()
      .min(1)
      .describe(
        'The instruction to send to the agent. Required, non-empty. Keep each prompt scoped to one coherent concern (one feature/fix/investigation) rather than bundling unrelated work — split unrelated concerns across separate prompts or sessions to avoid long, tangled sessions.',
      ),
    mode: z
      .enum(['auto', 'queue', 'steer', 'restart'])
      .optional()
      .describe(
        'Auto starts an idle session, prefers steering or queues. Queue waits for a separate turn. Steer requires a live turn. Restart interrupts the current turn before sending and requires an empty queue.',
      ),
    mentionSessionIds: sessionMentionIds,
    requestId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'Stable send ID. Reuse with identical inputs to recover this receipt without submitting twice.',
      ),
    notifyOnCompletion: z
      .boolean()
      .optional()
      .describe(
        'Defaults to true when messaging your own delegate, including follow-ups. False sends context without requesting a completion reply.',
      ),
  },
  handler: deliverSessionMessage,
});
