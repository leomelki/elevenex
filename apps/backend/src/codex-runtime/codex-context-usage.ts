import type { ClaudeContextUsage } from '../claude-runtime/claude-runtime.types.js';
import { contextPercentage } from '../agent-runtime/context-usage.js';
import { record } from './codex-subagents.js';

// Match Codex's native remaining-context display, which reserves prompt/tool space.
const CONTEXT_BASELINE_TOKENS = 12_000;

/** Latest response occupancy; cached/reasoning tokens are already included. */
export function codexContextUsage(
  model: string | null,
  last: unknown,
  window: unknown,
): ClaudeContextUsage | null {
  const usage = record(last);
  const input = usage.inputTokens ?? usage.input_tokens;
  const output = usage.outputTokens ?? usage.output_tokens;
  const cached = usage.cachedInputTokens ?? usage.cached_input_tokens ?? 0;
  const total =
    usage.totalTokens ??
    usage.total_tokens ??
    (typeof input === 'number' && typeof output === 'number'
      ? input + output
      : undefined);
  if (
    [input, output, cached, total].some(
      (value) =>
        typeof value !== 'number' || !Number.isFinite(value) || value < 0,
    ) ||
    typeof window !== 'number' ||
    contextPercentage(total as number, window) === null
  )
    return null;
  const effectiveWindow = window - CONTEXT_BASELINE_TOKENS;
  const used = Math.max(0, (total as number) - CONTEXT_BASELINE_TOKENS);
  const remaining = Math.max(0, effectiveWindow - used);
  return {
    model,
    totalTokens: total as number,
    maxTokens: window,
    percentage:
      effectiveWindow <= 0
        ? 100
        : 100 - Math.round((remaining / effectiveWindow) * 100),
    inputTokens: input as number,
    outputTokens: output as number,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached as number,
    tokenBreakdownAvailable: true,
    memoryFiles: [],
    mcpTools: [],
  };
}
