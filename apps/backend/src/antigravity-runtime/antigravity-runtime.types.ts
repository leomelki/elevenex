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
/* NOT verified against a live binary — field names are the best reading of   */
/* Google's public docs at the time this was written. `handleStepEvent` in    */
/* antigravity-transcript.ts is written defensively (missing/renamed fields   */
/* are skipped rather than throwing) so a wrong guess here degrades instead   */
/* of crashing a session. Correct this file first once a real `agy` process   */
/* has been observed. See docs/antigravity-provider-flow.md.                  */
/* -------------------------------------------------------------------------- */

export type AntigravityTurnStatus =
  | 'SUCCESS'
  | 'ERROR'
  | 'CANCELED'
  | 'INTERRUPTED'
  | 'INVALID'
  | 'WAITING'
  | 'RUNNING';

export interface AntigravityToolInfo {
  name?: string;
  parameters?: unknown;
  output?: string;
  error?: string;
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

/** A streamed step within a turn: text delta, tool call, or usage update. */
export interface AntigravityStepUpdateEvent {
  type: 'step_update';
  conversation_id?: string;
  /** Assistant prose delta, when this update carries one. */
  delta?: string;
  /** Set when the delta is reasoning/thinking rather than user-facing prose. */
  thought?: boolean;
  tool_info?: AntigravityToolInfo;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Terminal event for a turn. */
export interface AntigravityResultEvent {
  type: 'result';
  conversation_id?: string;
  status: AntigravityTurnStatus;
  response?: string;
  error?: string;
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
