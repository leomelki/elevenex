import type {
  ClaudeAuthStatus,
  ClaudeContextUsage,
  ClaudeModelOption,
  ClaudePermissionMode,
  ClaudePermissionRequest,
  ClaudeRuntimeSessionMetadata,
  ClaudeRuntimeStatePayload,
  ClaudeTranscriptItem,
  ClaudeUserInputRequest,
} from '../claude-runtime/claude-runtime.types.js';
import type { AgentImageInput } from '../agent-runtime/agent-runtime.types.js';

export type AntigravityRunPhase = 'idle' | 'running' | 'waiting' | 'error';

/* -------------------------------------------------------------------------- */
/* `agy --input-format stream-json --output-format stream-json` wire types     */
/*                                                                              */
/* Verified against `agy` 1.1.22 on Windows. Every line is an envelope of the  */
/* shape `{"event": "<name>", "<name>": { ...payload }}` — the payload is      */
/* nested under a key named after the event, NOT flattened onto the envelope.  */
/* `init` additionally repeats `conversation_id` on the envelope itself.       */
/* `AntigravityProcessClient.handleLine` unwraps this before emitting, so      */
/* everything downstream of it sees the payload types below directly.          */
/* See docs/antigravity-provider-flow.md.                                      */
/* -------------------------------------------------------------------------- */

export type AntigravityTurnStatus =
  | 'SUCCESS'
  | 'ERROR'
  | 'CANCELED'
  | 'INTERRUPTED'
  | 'INVALID'
  | 'WAITING'
  | 'RUNNING';

/**
 * Lifecycle of a single step. A tool step goes `ACTIVE` → `DONE` | `ERROR`.
 * The open `(string & {})` arm keeps completions for the known values while
 * still accepting a state this version of `agy` does not emit yet.
 */
export type AntigravityStepState =
  | 'ACTIVE'
  | 'DONE'
  | 'ERROR'
  | (string & NonNullable<unknown>);

/**
 * A tool error is an object (`{type, message}`), not a string — reading it as
 * a string silently drops every tool failure.
 */
export interface AntigravityToolError {
  type?: string;
  message?: string;
}

export interface AntigravityToolInfo {
  name?: string;
  parameters?: unknown;
  output?: string;
  error?: AntigravityToolError | string;
}

/** The first line a process emits after startup. */
export interface AntigravityInitEvent {
  type: 'init';
  conversation_id?: string;
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
  model?: string;
}

/**
 * A streamed step within a turn.
 *
 * `step_index` is stable across the updates for one step, so it — not a
 * synthesized id — is what correlates a tool call's `ACTIVE` start with its
 * later `DONE`/`ERROR` completion.
 */
export interface AntigravityStepUpdateEvent {
  type: 'step_update';
  conversation_id?: string;
  step_index?: number;
  state?: AntigravityStepState;
  step_type?:
    | 'user_input'
    | 'agent_response'
    | 'tool'
    | (string & NonNullable<unknown>);
  /** Assistant prose, delivered on `agent_response` steps. */
  text_delta?: string;
  /** Set when the text is reasoning/thinking rather than user-facing prose. */
  thought?: boolean;
  tool_name?: string;
  tool_info?: AntigravityToolInfo;
  duration_seconds?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

/** Terminal event for a turn. */
export interface AntigravityResultEvent {
  type: 'result';
  conversation_id?: string;
  status: AntigravityTurnStatus;
  response?: string;
  error?: string;
  num_turns?: number;
}

export type AntigravityStreamEvent =
  | AntigravityInitEvent
  | AntigravityStepUpdateEvent
  | AntigravityResultEvent
  | { type: string; [key: string]: unknown };

/* -------------------------------------------------------------------------- */
/* Elevenex-side runtime types                                                 */
/* -------------------------------------------------------------------------- */

export interface AntigravityAuthStatus extends ClaudeAuthStatus {
  [key: string]: unknown;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authPath: string;
  installHint: string | null;
}

export interface AntigravityRuntimeSessionMetadata
  extends Omit<
    ClaudeRuntimeSessionMetadata,
    'claudeCodeVersion' | 'apiKeySource' | 'plugins'
  > {
  antigravityVersion: string;
  plugins: [];
}

export interface AntigravityRuntimeStatePayload
  extends Omit<ClaudeRuntimeStatePayload, 'sessionMetadata' | 'authStatus'> {
  sessionMetadata: AntigravityRuntimeSessionMetadata | null;
  authStatus: AntigravityAuthStatus | ClaudeAuthStatus | null;
}

export interface AntigravitySessionSnapshotPayload
  extends AntigravityRuntimeStatePayload {
  history: ClaudeTranscriptItem[];
}

export interface AntigravityRuntimeState {
  /** `agy`'s own conversation id, persisted to `sessions.antigravity_session_id`. */
  antigravitySessionId: string | null;
  cachedWorktreePath: string | null;
  runPhase: AntigravityRunPhase;
  sessionState: 'idle' | 'running' | 'requires_action' | null;
  canInterrupt: boolean;
  pendingPrompts: {
    id: string;
    prompt: string;
    queuedAt: string;
    images?: AgentImageInput[];
  }[];
  liveItems: ClaudeTranscriptItem[];
  /**
   * Stable id for the assistant message / thought currently being streamed.
   * `step_update` delivers prose as a series of deltas with no message id, so
   * without this every delta would land as its own transcript entry.
   */
  streamingAssistantMessageId: string | null;
  streamingThoughtMessageId: string | null;
  /** Always null — see the "Permission model" note in the provider flow doc. */
  pendingPermissionRequest: ClaudePermissionRequest | null;
  pendingUserInputRequest: ClaudeUserInputRequest | null;
  lastError: string | null;
  selectedModel: string | null;
  reasoningEffort: string | null;
  fastMode: boolean;
  permissionMode: ClaudePermissionMode | null;
  /**
   * `agy` has no documented read-only mode; enabling this only forces the
   * safest (default) permission posture at spawn time rather than unlocking
   * any special read-only enforcement — see the "Permission model" note in
   * docs/antigravity-provider-flow.md.
   */
  planMode: boolean;
  availableModels: ClaudeModelOption[];
  contextUsage: ClaudeContextUsage | null;
  sessionMetadata: AntigravityRuntimeSessionMetadata | null;
  authStatus: AntigravityAuthStatus | null;
}

export interface AntigravityProcessExit {
  message: string;
  stderr: string;
  pid?: number;
}
