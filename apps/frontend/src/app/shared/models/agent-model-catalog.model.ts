import { ClaudeModelOption } from './claude-runtime.model';

/**
 * Session-independent view of a provider's selectable models and thinking
 * levels, served by `GET /api/agent-providers/models`. Providers report this
 * themselves, so a newly released model appears in settings with no frontend
 * change. Providers whose models are only discoverable per session (e.g. Pi
 * before its CLI has reported in) return an empty `models` list plus an
 * `unavailableReason` explaining why.
 */
export interface AgentProviderModelCatalog {
  provider: string;
  displayName: string;
  models: ClaudeModelOption[];
  /** Provider-wide levels; a model may narrow these via `reasoningEfforts`. */
  reasoningEfforts: string[];
  /** What the provider falls back to when nothing is pinned, if known. */
  providerDefaultModelId: string | null;
  /** False when a model cannot be chosen ahead of a session. */
  supportsModelSelection: boolean;
  unavailableReason?: string | null;
}
