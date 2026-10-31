import type { AgentConfig, AgentHarness } from '../conversation.models';

export interface PresetAgentCatalog {
  readonly harness: AgentHarness;
  readonly initial: AgentConfig;
  readonly reasoningAvailable: boolean;
  readonly fastAvailable: boolean;
}
/** The owner resolves a scoped read and honors cancellation; the form owns its unfinished choices. */
export type PresetCatalogProvider = (harnessId: string, signal: AbortSignal, refresh?: boolean) => Promise<PresetAgentCatalog>;
