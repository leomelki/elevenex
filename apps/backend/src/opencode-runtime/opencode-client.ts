import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';

export type OpenCodeSteerReceipt = (signal: AbortSignal) => Promise<boolean>;

export interface OpenCodeTurnSelection {
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  system?: string;
}

/** The subset of OpenCode operations Elevenex consumes. V1 and V2 implement this boundary. */
type Operation<Fn> = Fn extends (...args: infer Args) => infer Result
  ? (...args: Args) => Promise<{
      data?: Awaited<Result> extends infer Response
        ? Response extends { data?: infer Data }
          ? Data
          : never
        : never;
    }>
  : never;
type Operations<Group, Keys extends keyof Group> = {
  [Key in Keys]: Operation<Group[Key]>;
};
export interface OpenCodeClient {
  session: Operations<
    OpencodeClient['session'],
    | 'create'
    | 'get'
    | 'update'
    | 'delete'
    | 'messages'
    | 'status'
    | 'children'
    | 'prompt'
    | 'command'
    | 'abort'
    | 'fork'
    | 'deleteMessage'
  >;
  command: Operations<OpencodeClient['command'], 'list'>;
  config: Operations<OpencodeClient['config'], 'get'>;
  global: Operations<OpencodeClient['global'], 'health'>;
  provider: Operations<OpencodeClient['provider'], 'list' | 'auth'> & {
    oauth: Operations<
      OpencodeClient['provider']['oauth'],
      'authorize' | 'callback'
    >;
  };
  auth: Operations<OpencodeClient['auth'], 'set'>;
  instance: Operations<OpencodeClient['instance'], 'dispose'>;
  permission: Operations<OpencodeClient['permission'], 'list' | 'reply'>;
  question: Operations<OpencodeClient['question'], 'list' | 'reply' | 'reject'>;
  mcp: Operations<
    OpencodeClient['mcp'],
    'connect' | 'disconnect'
  > & {
    status(): Promise<{ data?: Record<string, { status: string; error?: string }> }>;
    auth: Operations<OpencodeClient['mcp']['auth'], 'start'>;
  };
  event: Pick<OpencodeClient['event'], 'subscribe'>;
  /** Protocol-specific operations implemented by the adapters. */
  moveSession?(sessionID: string, directory: string): Promise<void>;
  rewindHistory?(sessionID: string, messageID: string): Promise<void>;
  steerPrompt?(
    sessionID: string,
    prompt: string,
    selection?: OpenCodeTurnSelection,
    options?: { signal?: AbortSignal },
  ): Promise<void | OpenCodeSteerReceipt>;
  answerForm?(
    requestID: string,
    content: Record<string, string | number | boolean | string[]>,
  ): Promise<void>;
  cancelOAuth?(): Promise<void>;
  resources?(): Promise<{
    defaultAgent?: string;
    agents: {
      id: string;
      name: string;
      description?: string;
      primary: boolean;
    }[];
    skills: { id: string; name: string; description?: string }[];
  }>;
  selection?(
    sessionID: string,
  ): Promise<{ model: string | null; variant: string | null; agent?: string }>;
  compact?(
    sessionID: string,
    selection?: OpenCodeTurnSelection,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  activateSkill?(
    sessionID: string,
    id: string,
    selection?: OpenCodeTurnSelection,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  selectAgent?(
    sessionID: string,
    agent: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}
