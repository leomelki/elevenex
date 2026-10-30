import { canonicalizeAgentTool } from '../agent-runtime/agent-tool-normalization.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import { record } from './codex-subagents.js';
import { codexWebSearchInput } from './codex-web-search.js';

/** Rollouts retain native tool receipts inside code-mode exec calls. Decode
 * those receipts rather than presenting the JavaScript wrapper as the work. */
function codexHistoryTool(
  item: Record<string, unknown>,
  timestamp: string,
  transcriptMessageId: string,
): ClaudeTranscriptItem[] {
  if (typeof item.id !== 'string') return [];
  let name: string;
  let input: Record<string, unknown>;
  let content: string;
  let isError = item.status === 'failed' || item.status === 'declined';
  switch (item.type) {
    case 'CommandExecution':
      name = 'Bash';
      input = {
        command: text(item.command),
        ...(Array.isArray(item.parsed_cmd)
          ? { commandActions: item.parsed_cmd }
          : {}),
      };
      content = text(item.aggregated_output);
      isError ||= typeof item.exit_code === 'number' && item.exit_code !== 0;
      break;
    case 'FileChange': {
      name = 'FileChanges';
      const changes = Object.entries(record(item.changes)).map(
        ([path, raw]) => {
          const change = record(raw);
          return {
            path,
            kind: change.type,
            diff: change.unified_diff ?? change.content,
            ...(typeof change.move_path === 'string'
              ? { movePath: change.move_path }
              : {}),
          };
        },
      );
      input = { changes };
      content = [
        ...changes.map((change) => `${String(change.kind)}: ${change.path}`),
        text(item.stdout),
        text(item.stderr),
      ]
        .filter(Boolean)
        .join('\n');
      break;
    }
    case 'McpToolCall': {
      name = text(item.tool) || 'MCP tool';
      input = { server: item.server, arguments: item.arguments };
      const result = record(item.result);
      isError ||= Boolean(item.error) || result.isError === true;
      content = text(record(item.error).message) || resultText(item.result);
      break;
    }
    case 'Extension':
      if (item.kind !== 'web.search') return [];
      name = 'WebSearch';
      input = codexWebSearchInput(item);
      content = resultText(item.results);
      break;
    default:
      return [];
  }
  const common = {
    toolUseId: item.id,
    sourceMessageId: item.id,
    transcriptMessageId,
    timestamp,
  };
  return [
    {
      ...common,
      id: `${item.id}:tool_use`,
      kind: 'tool_use',
      toolName: name,
      providerToolName: name,
      ...canonicalizeAgentTool(name, input),
      providerToolInput: input,
      receivedAt: timestamp,
    },
    {
      ...common,
      id: `${item.id}:tool_result`,
      kind: 'tool_result',
      content,
      providerToolResult: item.result,
      isError,
      authoredAt: timestamp,
    },
  ];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resultText(value: unknown): string {
  const content = record(value).content;
  if (Array.isArray(content)) {
    const parts = content.flatMap((part) => {
      const block = record(part);
      return block.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : [];
    });
    if (parts.length) return parts.join('\n');
  }
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

export function codexHistoryTools(records: readonly Record<string, unknown>[]) {
  const native = new Map<number, ClaudeTranscriptItem[]>();
  const nativeToolIds = new Set<string>();
  const wrappers = new Set<string>();
  const activeWrappers = new Set<string>();
  for (const [index, entry] of records.entries()) {
    const payload = record(entry.payload);
    const response = record(payload.item ?? payload);
    if (entry.type === 'response_item') {
      const callId = response.call_id;
      if (typeof callId !== 'string') continue;
      if (response.type === 'custom_tool_call' && response.name === 'exec')
        activeWrappers.add(callId);
      if (response.type === 'custom_tool_call_output')
        activeWrappers.delete(callId);
    }
    if (entry.type !== 'event_msg' || payload.type !== 'item_completed')
      continue;
    const items = codexHistoryTool(
      record(payload.item),
      text(entry.timestamp) || new Date().toISOString(),
      `codex-record:${index}`,
    );
    if (!items.length) continue;
    native.set(index, items);
    nativeToolIds.add(items[0].toolUseId!);
    for (const id of activeWrappers) wrappers.add(id);
  }
  return { native, nativeToolIds, wrappers };
}
