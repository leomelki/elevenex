import { canonicalizeAgentTool } from '../agent-runtime/agent-tool-normalization.js';
import type { AgentToolKind } from '../claude-runtime/claude-runtime.types.js';
import type { AntigravityToolInfo } from './antigravity-runtime.types.js';

export interface CanonicalAntigravityTool {
  toolKind: AgentToolKind;
  toolDisplayName: string;
  toolInput: unknown;
  providerToolName: string;
}

/**
 * Maps an `agy` `tool_info` payload onto the shared tool taxonomy so
 * Antigravity tool cards render with the same components as every other
 * provider's.
 *
 * Unlike ACP's `tool_call` (which carries a coarse `kind` fallback),
 * `tool_info` is documented with only `name`/`parameters`/`output`/`error`,
 * so there's no fallback taxonomy to consult when the name doesn't match a
 * known tool — it renders as `unknown` with the raw name shown, same as an
 * unrecognized tool from any other provider.
 */
export function canonicalizeAntigravityTool(
  info: AntigravityToolInfo,
): CanonicalAntigravityTool {
  const name = typeof info.name === 'string' && info.name.trim() ? info.name : undefined;
  const canonical = canonicalizeAgentTool(name, info.parameters);
  return { ...canonical, providerToolName: name ?? 'Tool' };
}

/** Renders the result side of a tool call: `output` on success, `error` on failure. */
export function toolInfoResultText(info: AntigravityToolInfo): string {
  if (typeof info.error === 'string' && info.error) return info.error;
  if (typeof info.output === 'string') return info.output;
  return '';
}

/** True once a `tool_info` payload has settled (has output or an error). */
export function toolInfoIsComplete(info: AntigravityToolInfo): boolean {
  return typeof info.output === 'string' || typeof info.error === 'string';
}
