import { ClaudeModelOption } from './claude-runtime.model';
import { DefaultAgentProvider } from './app-settings.model';

/**
 * Session-independent view of a provider's selectable models and reasoning
 * levels, served by `GET /api/agent-providers/models`. Providers whose models
 * are only discoverable per session (e.g. Pi) return an empty `models` list.
 */
export interface AgentProviderModelCatalog {
  provider: DefaultAgentProvider;
  displayName: string;
  models: ClaudeModelOption[];
  reasoningEfforts: string[];
}
