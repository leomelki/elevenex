import { z } from 'zod';
import { defineTool } from '../../tool-registry/tool.types.js';

export const runLocalBashTool = defineTool({
  name: 'run_local_bash',
  title: 'Run Bash on local computer',
  costClass: 'heavy',
  requiresAgent: true,
  destructive: true,
  annotations: { openWorldHint: true },
  description:
    'Run a Bash command on the local computer the human is using, not on the current remote backend. 🔴heavy. Available only when the human explicitly enables Local computer Bash in Elevenex Settings. Use for local-only files, programs, devices, or credentials; use the normal Bash tool for the remote environment.',
  inputShape: {
    command: z
      .string()
      .min(1)
      .max(65_536)
      .describe("Bash command to run on the human's local computer."),
    cwd: z
      .string()
      .min(1)
      .max(4_096)
      .optional()
      .describe(
        'Optional absolute working directory on the local computer. Defaults to its home directory.',
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000)
      .describe(
        'Command timeout in milliseconds (1,000–120,000). Default 30,000.',
      ),
  },
  handler: async (args, ctx) => ({
    data: await ctx.services.localComputer.runBash({
      command: args.command,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      signal: ctx.signal,
    }),
  }),
});
