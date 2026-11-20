import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Keep execution facts separate from output without forwarding provider payloads. */
export function commandExecution(item: AgentTranscriptItem, call?: AgentTranscriptItem) {
  const source = item.kind === 'tool_use' ? item : call;
  const input = record(source?.toolInput);
  if (source?.toolKind !== 'bash' && !input.command && !input.cmd) return undefined;
  return commandFacts(item, input);
}

export function commandFacts(item: AgentTranscriptItem, input = record(item.toolInput)) {
  const result = record(item.providerToolResult);
  const exitCode = result.exitCode ?? result.exit_code;
  const cwd = input.cwd ?? input.workdir ?? result.cwd;
  const interrupted = result.interrupted;
  const execution = {
    ...(typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(typeof cwd === 'string' && cwd.length <= 4000 ? { cwd } : {}),
    ...(typeof interrupted === 'boolean' ? { interrupted } : {}),
  };
  return Object.keys(execution).length ? execution : undefined;
}

export function chatItemFailed(item: AgentTranscriptItem, execution = commandExecution(item)) {
  return item.isError === true || execution?.interrupted === true ||
    (execution?.exitCode !== undefined && execution.exitCode !== 0);
}
