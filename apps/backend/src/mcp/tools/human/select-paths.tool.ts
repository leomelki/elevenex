import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';
import { resolveDeepLink } from './deep-link-arg.js';

/**
 * select_paths — LAST-RESORT interactive file/folder picker. BLOCKS until the
 * human picks path(s), replies with free text, defers back to the agent, or it
 * times out. 🔴heavy (waits for a person). Only reach for this after your own
 * search has genuinely failed or is too ambiguous to resolve on your own.
 */
export const selectPathsTool = defineTool({
  name: 'select_paths',
  title: 'Select files or folders',
  costClass: 'heavy',
  requiresAgent: true,
  description:
    "Ask the human to point you at the exact file(s)/folder(s) through an interactive tree picker, and BLOCK until they answer. 🔴heavy (waits for a person). LAST RESORT — call this ONLY when you cannot locate the right path yourself: you've already used your search/list/read tools (Glob/Grep/find_* /read_file) and still can't identify it, OR several candidates match and guessing wrong is costly. Do NOT use it to skip a search you could run, to confirm a path you already found, or when the user's message already names the file/folder. The human isn't obligated to pick: they can reply with free text or hand the choice back ('let the agent decide'), so treat any non-selection as 'keep resolving it yourself, now with their hint'. Returns { outcome: 'selected'|'text'|'defer'|'cancelled', paths?, text? } where paths are relative to rootPath. For a yes/no or fixed-option decision use request_approval; for an open-ended question use escalate_to_user.",
  inputShape: {
    title: z
      .string()
      .min(1)
      .describe(
        'One line naming what you need the human to locate (e.g. "Which config file holds the DB URL?").',
      ),
    detail: z
      .string()
      .optional()
      .describe(
        'Optional context: what you already tried and why you are stuck, so the human can help fast.',
      ),
    rootPath: z
      .string()
      .min(1)
      .describe(
        "Absolute path to the worktree/repo root the human browses from — the picker lists this tree. Use a session's worktreePath (from create_session / find_sessions / project_overview).",
      ),
    selectionKind: z
      .enum(['file', 'folder', 'any'])
      .default('any')
      .describe(
        "What the human may pick: 'file' (files only), 'folder' (directories only), or 'any' (either). Default 'any'.",
      ),
    multiple: z
      .boolean()
      .default(true)
      .describe('Allow selecting more than one entry. Default true.'),
    allowText: z
      .boolean()
      .default(true)
      .describe(
        'Let the human reply with free text instead of a selection (e.g. a hint or a path you should use). Default true.',
      ),
    allowDefer: z
      .boolean()
      .default(true)
      .describe(
        "Let the human hand the decision back to you ('let the agent decide') without picking. Default true.",
      ),
    sessionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional: Open→session deep link.'),
    projectId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional: Open→project deep link.'),
    deepLink: z
      .string()
      .optional()
      .describe('Optional explicit deep link; overrides sessionId/projectId.'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(30 * 60 * 1000)
      .default(10 * 60 * 1000)
      .describe('Max wait before resolving as cancelled (1s–30m). Default 10m.'),
  },
  handler: async (args, ctx) => {
    const deepLink = resolveDeepLink(ctx, args);
    const resolution = await ctx.human.requestSelection({
      title: args.title,
      detail: args.detail,
      rootPath: args.rootPath,
      selectionKind: args.selectionKind,
      multiple: args.multiple,
      allowText: args.allowText,
      allowDefer: args.allowDefer,
      deepLink,
      timeoutMs: args.timeoutMs,
    });

    switch (resolution.outcome) {
      case 'selected': {
        const paths = resolution.paths ?? [];
        return {
          data: {
            outcome: 'selected' as const,
            paths,
            path: paths.length === 1 ? paths[0].path : undefined,
          },
          deepLink,
          nextStep:
            'Human picked these paths (relative to rootPath) — use them directly.',
        };
      }
      case 'text':
        return {
          data: { outcome: 'text' as const, text: resolution.text ?? '' },
          deepLink,
          nextStep:
            "Human replied with free text instead of picking — treat it as a hint and resolve the path yourself.",
        };
      case 'defer':
      case 'cancelled':
      default:
        return {
          data: { outcome: resolution.outcome },
          deepLink,
          nextStep:
            'Human did not pick (deferred/cancelled) — decide yourself with your best judgement; do not re-ask unless you have new, narrower options.',
        };
    }
  },
});
