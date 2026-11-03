import { z } from 'zod';
const reply = z.object({
  active: z.string().uuid().nullable().optional(),
  tabs: z.array(z.object({
    id: z.string().uuid(), agentSessionId: z.number().int().positive().safe().nullable().optional(), by: z.enum(['you', 'agent']), driver: z.enum(['you', 'agent', 'needs']),
    generation: z.number().int().positive().safe(), loading: z.boolean(), ready: z.boolean().optional(),
    error: z.literal('Page unavailable; ask the user to inspect it.').nullable(),
    errors: z.number().int().min(0).max(999).optional(),
  }).strict()).max(12),
  observation: z.literal('withheld'),
  message: z.string().max(512),
}).strict();
/** A second allowlist at the agent boundary prevents a future desktop accidentally exporting content. */
export function browserReply(value: unknown) {
  const parsed = reply.parse(value);
  return { active: parsed.active ?? null, tabs: parsed.tabs, observation: parsed.observation,
    message: 'Page text, screenshots, accessibility and raw logs are withheld. Ask the user to inspect the page or share context explicitly.' };
}
