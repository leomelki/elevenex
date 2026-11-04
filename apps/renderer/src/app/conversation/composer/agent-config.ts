import type { AgentConfig, AgentHarness } from "../conversation.models";

/**
 * Pure config transitions shared by the composer's agent menu and the preset
 * form. Any manual change leaves the preset, which no longer describes the mix.
 */
export function withHarness(
  value: AgentConfig,
  harness: AgentHarness,
): AgentConfig {
  const model = harness.models[0];
  return {
    ...value,
    preset: undefined,
    harness: harness.id,
    mark: harness.mark,
    model: model?.id ?? "",
    thinking: model?.thinking[0],
    fast: false,
    context: undefined,
    tokens: undefined,
    plan: undefined,
  };
}

/** Keeps the thinking level when the new model supports it. */
export function withModel(
  value: AgentConfig,
  model: AgentHarness["models"][number],
): AgentConfig {
  return {
    ...value,
    preset: undefined,
    model: model.id,
    thinking: model.thinking.includes(value.thinking ?? "")
      ? value.thinking
      : model.thinking[0],
  };
}

/** Provider IDs stay exact; only their display is normalized. */
export function thinkingLabel(level: string): string {
  const id = level.toLowerCase();
  return id === "xhigh"
    ? "Extra high"
    : level.charAt(0).toUpperCase() + level.slice(1);
}
