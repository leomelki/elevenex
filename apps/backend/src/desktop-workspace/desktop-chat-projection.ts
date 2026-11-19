import { chatMedia } from './desktop-chat-media.js';
import { chatMentionText, projectChatMentions } from './desktop-chat-mentions.js';
import { changeSummary, toolChanges } from './desktop-chat-changes.js';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function display(value: unknown, limit = 16000): string {
  const text =
    typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value, null, 2);
  const suffix = '\n… [display shortened]';
  return text.length > limit
    ? text.slice(0, Math.max(0, limit - suffix.length)) + suffix
    : text;
}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const nullable = (value: unknown) =>
  typeof value === 'string' ? display(value, 1000) : null;
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
export type ChatMediaCache = WeakMap<AgentTranscriptItem, ReturnType<typeof chatMedia>>;
export type ChatChangesCache = WeakMap<AgentTranscriptItem, { readonly result: AgentTranscriptItem; readonly fingerprint: string; readonly changes: ReturnType<typeof changeSummary> }>;
/** Keep execution facts separate from output without forwarding provider payloads. */
export function commandExecution(item: AgentTranscriptItem, call?: AgentTranscriptItem) {
  const source = item.kind === 'tool_use' ? item : call;
  const input = record(source?.toolInput);
  if (source?.toolKind !== 'bash' && !input.command && !input.cmd) return undefined;
  const result = record(item.providerToolResult);
  const exitCode = result.exitCode ?? result.exit_code;
  const cwd = input.cwd ?? input.workdir ?? result.cwd;
  const interrupted = result.interrupted;
  const execution = {
    ...(typeof exitCode === 'number' && Number.isSafeInteger(exitCode)
      ? { exitCode }
      : {}),
    ...(typeof cwd === 'string' && cwd.length <= 4000 ? { cwd } : {}),
    ...(typeof interrupted === 'boolean' ? { interrupted } : {}),
  };
  return Object.keys(execution).length ? execution : undefined;
}
export function chatItemFailed(item: AgentTranscriptItem, execution = commandExecution(item)) {
  return item.isError === true || execution?.interrupted === true ||
    (execution?.exitCode !== undefined && execution.exitCode !== 0);
}

export function chatItemChanges(item: AgentTranscriptItem, call?: AgentTranscriptItem, cache?: ChatChangesCache) {
  if (item.turnChanges) return changeSummary(item.turnChanges);
  if (!call || !['write', 'edit', 'file_changes', 'notebook_edit', 'bash'].includes(call.toolKind ?? '')) return undefined;
  const previous = cache?.get(call);
  const fingerprint = JSON.stringify([call.toolKind, display(call.toolInput, 32000), item.isError, call.toolKind === 'bash' ? display(item.providerToolResult, 32000) : null]);
  const changes = previous?.result === item && previous.fingerprint === fingerprint
    ? previous.changes : changeSummary(toolChanges(call, item));
  cache?.set(call, { result: item, fingerprint, changes });
  return changes;
}

export function chatItem(item: AgentTranscriptItem, call?: AgentTranscriptItem, cache?: ChatChangesCache, mediaCache?: ChatMediaCache) {
  const execution = commandExecution(item, call);
  const input = display(item.toolInput);
  const original = item.content ?? item.providerToolResult ?? item.agentMessage?.body;
  const context = item.kind === 'user' && typeof original === 'string' ? projectChatMentions(original) : null;
  const projected = mediaCache?.get(item) ?? chatMedia(context ? { ...item, content: context.text } : item);
  mediaCache?.set(item, projected);
  const text = display(projected.text, item.kind === 'user' ? 64000 : 16000);
  const changes = chatItemChanges(item, call, cache);
  return {
    ...(context?.mentions.length ? { mentions: context.mentions } : {}),
    ...(projected.media.length ? { media: projected.media.map(media => ({ id: media.id, path: media.path, caption: media.caption, inline: media.inline, ...(media.kind ? { kind: media.kind } : {}) })) } : {}),
    ...(execution ? { execution } : {}),
    ...(changes ? { changes } : {}),
    id: item.id,
    kind: item.kind,
    text,
    timestamp: item.timestamp,
    toolId: item.toolUseId ?? null,
    toolName:
      item.toolDisplayName ?? item.providerToolName ?? item.toolName ?? null,
    toolKind: item.toolKind ?? null,
    input,
    error: chatItemFailed(item, execution),
    truncated:
      projected.shortened || text.endsWith('… [display shortened]') ||
      input.endsWith('… [display shortened]'),
  };
}
export function chatState(
  raw: Record<string, unknown>,
  provider: string,
  permissionModes: readonly string[],
) {
  const permission = record(raw.pendingPermissionRequest),
    usage = record(raw.contextUsage);
  const permissionQuestion =
    permission.toolKind === 'ask_user_question' ||
    String(permission.toolName).toLowerCase() === 'askuserquestion';
  const question = permissionQuestion
    ? {
        ...permission,
        ...record(permission.input),
        message: permission.description ?? '',
      }
    : record(raw.pendingUserInputRequest);
  const questions = list(question.questions)
    .slice(0, 20)
    .map((value, index) => {
      const q = record(value);
      return {
        id: display(q.id ?? q.question ?? index, 1000),
        question: display(q.question, 4000),
        multiple: q.multiSelect === true,
        options: list(q.options)
          .slice(0, 30)
          .map((value) => {
            const option = record(value);
            return {
              label: display(option.label, 1000),
              detail: display(option.description, 2000),
            };
          }),
      };
    });
  if (!questions.length) {
    for (const [id, value] of Object.entries(
      record(record(question.requestedSchema).properties),
    ).slice(0, 20)) {
      const field = record(value);
      const choices =
        field.type === 'boolean' ? ['true', 'false'] : list(field.enum);
      questions.push({
        id,
        question: display(field.title ?? field.description ?? id, 4000),
        multiple: false,
        options: choices
          .slice(0, 30)
          .map((value) => ({ label: display(value, 1000), detail: '' })),
      });
    }
  }
  return {
    provider,
    phase: ['idle', 'running', 'waiting', 'error'].includes(
      String(raw.runPhase),
    )
      ? String(raw.runPhase)
      : 'idle',
    canInterrupt: raw.canInterrupt === true,
    error: nullable(raw.lastError),
    model: nullable(raw.selectedModel),
    models: list(raw.availableModels)
      .slice(0, 100)
      .map((value) => {
        const m = record(value);
        return {
          id: display(m.id, 1000),
          label: display(m.displayName ?? m.id, 1000),
          ...(m.supportsEffort === false
            ? { reasoningEfforts: [] }
            : Array.isArray(m.reasoningEfforts)
              ? {
                  reasoningEfforts: m.reasoningEfforts
                    .slice(0, 20)
                    .map((effort) => display(effort, 1000)),
                }
              : {}),
          ...(typeof m.supportsFastMode === 'boolean'
            ? { supportsFastMode: m.supportsFastMode }
            : {}),
        };
      }),
    reasoning: nullable(raw.reasoningEffort),
    fast: raw.fastMode === true,
    plan: raw.planMode === true,
    permissionMode: nullable(raw.permissionMode),
    permissionModes: permissionModes.slice(0, 20),
    context: raw.contextUsage
      ? {
          tokens: count(usage.totalTokens),
          limit: count(usage.maxTokens),
          percentage: Math.min(100, count(usage.percentage)),
        }
      : null,
    queue: list(raw.pendingPrompts)
      .slice(0, 50)
      .map((value) => {
        const p = record(value);
        return { id: display(p.id, 1000), text: display(chatMentionText(typeof p.prompt === 'string' ? p.prompt : ''), 64000) };
      }),
    queuePaused: raw.queuePaused === true,
    permission:
      permission.requestId && !permissionQuestion
        ? {
            id: display(permission.requestId, 1000),
            title: display(
              permission.title ??
                permission.toolDisplayName ??
                permission.toolName,
              1000,
            ),
            description: display(
              permission.description ?? permission.decisionReason,
              4000,
            ),
            input: display(permission.batch ?? permission.input),
            allowAlways: permission.suppressAlwaysAllowRule !== true,
          }
        : null,
    question: question.requestId
      ? {
          id: display(question.requestId, 1000),
          message: display(question.message, 4000),
          questions,
          url: nullable(question.url),
        }
      : null,
  };
}
