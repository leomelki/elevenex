import { z } from 'zod';

const port = () => z.number().int().min(1).max(65535);
const host = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9._:[\]-]+$/)
    .refine(
      (value) => !value.startsWith('-'),
      'Hosts cannot start with an SSH option.',
    );
export const forwardId = () => z.number().int().positive().safe();

/** Agent input deliberately carries no passwords, keys, or public bind address. */
export const createForwardShape = {
  remotePort: port().describe(
    'TCP port of the service on the remote machine (1–65535).',
  ),
  localPort: port()
    .optional()
    .describe(
      'Port on the user’s desktop; defaults to remotePort. Choose another if occupied.',
    ),
  remoteHost: host()
    .default('localhost')
    .describe(
      'Destination host as seen from the remote machine. Default localhost supports IPv4 and IPv6.',
    ),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe('Optional display name; defaults to Port <remotePort>.'),
  sshHost: host()
    .optional()
    .describe(
      'Optional SSH host or config alias; defaults to the desktop’s active SSH connection. Omit for paired desktops.',
    ),
  sshUser: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional()
    .describe('Optional SSH user override. Credentials remain on the desktop.'),
  sshPort: port()
    .optional()
    .describe(
      'Optional SSH server port; defaults to the active connection’s port, or 22 for an explicit host.',
    ),
  startImmediately: z
    .boolean()
    .default(true)
    .describe(
      'Start after saving (default true); false saves an inactive definition.',
    ),
};
export const createForwardSchema = z.object(createForwardShape);

export const desktopSchema = z.object({
  desktopId: z.string().min(1).max(80),
  windowId: z.string().min(1).max(80),
  mode: z.enum(['local', 'ssh', 'paired', 'wsl']),
  connectionLabel: z.string().max(300),
  defaultConnection: z.enum(['ssh', 'paired']).nullable(),
});
export const desktopMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('register'), context: z.unknown() }),
  z.object({
    type: z.literal('response'),
    id: z.string().min(1).max(80),
    data: z.unknown().optional(),
    error: z.string().max(4000).optional(),
  }),
]);
export const forwardSchema = z.object({
  createdBySession: z
    .object({ sessionId: forwardId(), sessionName: z.string().max(300) })
    .optional(),
  id: forwardId(),
  projectId: forwardId(),
  name: z.string().max(120),
  transport: z.enum(['ssh', 'paired']),
  connectionLabel: z.string().max(300),
  bindAddress: z.string().max(253),
  localPort: port(),
  remoteHost: z.string().max(253),
  remotePort: port(),
  status: z.enum(['inactive', 'connecting', 'active', 'stopping', 'error']),
  running: z.boolean(),
  localUrl: z.string().max(300),
  lastError: z.string().max(4000).nullable(),
});
export const responseSchema = z.object({
  forwards: z.array(forwardSchema).max(100),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  reused: z.boolean().optional(),
  removed: z.boolean().optional(),
});
export type DesktopForwardingContext = z.infer<typeof desktopSchema>;
export type ForwardResponse = z.infer<typeof responseSchema>;
export type ForwardOperation =
  | 'list'
  | 'get'
  | 'create'
  | 'start'
  | 'stop'
  | 'remove';
