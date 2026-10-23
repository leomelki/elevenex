import type { ClaudeTranscriptItem } from '../../../claude-runtime/claude-runtime.types.js';
import type {
  ConversationExportOptions,
  ConversationExportTurn,
} from '../../../agent-runtime/conversation-export.service.js';

/** Lazy views of the fields the markdown renderer consumes. Never walk omitted
 * payloads just to apply a budget: small precision must stay independent of
 * work/preamble size, and medium precision must not inspect tool output. Each
 * loop yields a value so the validator can bound work and yield to cancellation.
 */
export function* turnRenderProjection(
  turn: ConversationExportTurn,
  options: ConversationExportOptions,
): Generator<unknown> {
  for (const item of [turn.user, turn.finalResponse]) {
    if (!item) continue;
    yield item.content;
    if (options.includeIds) yield item.id;
  }
  if (options.precision !== 'small')
    yield* stepsRenderProjection(turn.steps, options);
  if (!options.includeChanges || !turn.changes) return;
  const changes = turn.changes;
  yield [changes.files, changes.additions, changes.deletions];
  yield changes.capture?.shared;
  yield changes.capture?.complete;
  if (changes.capture && !changes.capture.complete)
    yield changes.capture.message;
  for (const file of changes.filesChanged) {
    yield [
      file.path,
      file.status,
      file.additions,
      file.deletions,
      file.diffUnavailable,
    ];
    if (options.precision !== 'full') continue;
    for (const hunk of file.hunks) {
      if (hunk.patch != null) yield hunk.patch;
      else yield [hunk.oldString, hunk.newString];
    }
  }
}

export function* stepsRenderProjection(
  items: ClaudeTranscriptItem[],
  options: ConversationExportOptions,
): Generator<unknown> {
  const results = new Map<string, ClaudeTranscriptItem>();
  // renderSteps scans every item's kind, but consumes result bodies only for
  // paired tool calls at full precision. Keep this scan bounded even if every
  // item is omitted; unlike small precision, the renderer must walk this array.
  for (const item of items) {
    yield item.kind;
    if (item.kind === 'tool_result') {
      yield item.toolUseId;
      if (item.toolUseId) results.set(item.toolUseId, item);
    }
  }
  for (const item of items) {
    switch (item.kind) {
      case 'thinking':
      case 'system':
      case 'assistant':
        if (item.kind !== 'assistant' && options.precision !== 'full') break;
        yield item.content;
        if (options.includeIds && item.content?.trim()) yield item.id;
        break;
      case 'tool_use': {
        yield item.toolDisplayName || item.toolName;
        if (options.includeIds) yield item.id;
        yield* toolInputProjection(item);
        yield item.toolUseId || item.id;
        const result = results.get(item.toolUseId || item.id);
        if (options.precision === 'full' && result) {
          yield result.content;
          yield result.isError;
        }
        break;
      }
    }
  }
}

function* toolInputProjection(item: ClaudeTranscriptItem): Generator<unknown> {
  yield item.toolName;
  const input = record(item.toolInput);
  if (!input) {
    yield text(item.toolInput);
    return;
  }
  yield firstString(input, [
    'file_path',
    'filePath',
    'notebook_path',
    'notebookPath',
    'path',
    'pattern',
  ]);
  const name = (item.toolName || '').toLowerCase().replace(/[_-]/g, '');
  switch (name) {
    case 'bash':
      yield firstString(input, ['command', 'cmd']);
      yield text(input['description']);
      break;
    case 'write':
      yield firstString(input, ['file_path', 'filePath', 'path']);
      yield text(input['content']);
      break;
    case 'edit':
      yield text(input['old_string']);
      yield text(input['new_string']);
      break;
    case 'multiedit':
      if (Array.isArray(input['edits'])) {
        for (const raw of input['edits']) {
          const edit = record(raw);
          yield edit
            ? [text(edit['old_string']), text(edit['new_string'])]
            : null;
        }
      }
      break;
    default:
      // Generic inputs are serialized recursively, unlike the tailored layouts.
      yield input;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = text(input[key]);
    if (value) return value;
  }
  return '';
}
