import { chatMedia } from './desktop-chat-media.js';
import type { SessionChatRecord, SessionChatState } from '@elevenex/shared';
import { chatMentionText, projectChatMentions } from './desktop-chat-mentions.js';
import { changeSummary, toolChanges } from './desktop-chat-changes.js';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { chatItemFailed, commandExecution, record } from './desktop-chat-tool-outcome.js';
import { splitSessionAgentPrompt } from '../sessions/session-agent-message.js';
import { chatAgentEntry } from './desktop-chat-agent-tools.js';

export { record } from './desktop-chat-tool-outcome.js';
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
type ChatDisplayContent = Pick<SessionChatRecord, 'text' | 'truncated' | 'mentions' | 'media' | 'sender'>;
export type ChatMediaCache = WeakMap<AgentTranscriptItem, ChatDisplayContent>;
export type ChatChangesCache = WeakMap<AgentTranscriptItem, { readonly result: AgentTranscriptItem; readonly fingerprint: string; readonly changes: ReturnType<typeof changeSummary> }>;

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

export function chatDisplayContent(item: AgentTranscriptItem, cache?: ChatMediaCache): ChatDisplayContent {
  const cached = cache?.get(item);
  if (cached) return cached;
  const original = item.content ?? item.providerToolResult ?? item.agentMessage?.body;
  const prompt = item.kind === 'user' && typeof original === 'string' ? splitSessionAgentPrompt(original) : undefined;
  const context = prompt ? projectChatMentions(prompt.text) : null;
  const content = chatMedia(context ? { ...item, content: context.text } : item);
  const text = display(content.text, item.kind === 'user' ? 64000 : 16000);
  const projected = {
    text,
    truncated: content.shortened || text.endsWith('… [display shortened]'),
    ...(context?.mentions.length ? { mentions: context.mentions } : {}),
    ...(prompt?.sender ? { sender: prompt.sender } : {}),
    ...(content.media.length ? { media: content.media.map(media => ({ id: media.id, path: media.path, caption: media.caption, inline: media.inline, ...(media.kind ? { kind: media.kind } : {}) })) } : {}),
  };
  cache?.set(item, projected);
  return projected;
}

export function chatItem(item: AgentTranscriptItem, call?: AgentTranscriptItem, cache?: ChatChangesCache, mediaCache?: ChatMediaCache): SessionChatRecord {
  const execution = commandExecution(item, call);
  const input = display(item.toolInput);
  // Keep only bounded display data. Original text and media sources can be
  // reconstructed from the transcript when their dedicated readers need them.
  const projected = chatDisplayContent(item, mediaCache);
  const changes = chatItemChanges(item, call, cache);
  const agent = chatAgentEntry(item, call);
  return {
    ...projected,
    ...(execution ? { execution } : {}),
    ...(changes ? { changes } : {}),
    ...(agent ? { agent } : {}),
    id: item.id,
    kind: item.kind,
    ...(item.kind === 'assistant' && item.assistantPhase ? { assistantPhase: item.assistantPhase } : {}),
    timestamp: item.timestamp,
    toolId: item.toolUseId ?? null,
    toolName:
      item.toolDisplayName ?? item.providerToolName ?? item.toolName ?? null,
    toolKind: item.toolKind ?? null,
    input,
    error: chatItemFailed(item, execution),
    truncated: projected.truncated || input.endsWith('… [display shortened]'),
  };
}
export function chatState(
  raw: Record<string, unknown>,
  provider: string,
  permissionModes: readonly string[],
): Omit<SessionChatState, 'activity'> {
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
  const phase = String(raw.runPhase);
  const activePrompt = phase === 'running' || phase === 'waiting'
    ? record(list(raw.liveItems).findLast(item => record(item).kind === 'user')).id
    : undefined;
  return {
    provider,
    phase: phase === 'running' || phase === 'waiting' || phase === 'error' ? phase : 'idle',
    ...(typeof activePrompt === 'string' && activePrompt.length > 0 && activePrompt.length <= 1000
      ? { activePromptId: activePrompt } : {}),
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
        const prompt = splitSessionAgentPrompt(typeof p.prompt === 'string' ? p.prompt : '');
        return { id: display(p.id, 1000), text: display(chatMentionText(prompt.text), 64000),
          ...(prompt.sender ? { sender: prompt.sender } : {}) };
      }),
    queuePaused: raw.queuePaused === true,
    ...(Array.isArray(raw.dispatchingPrompts) ? {
      dispatchingPrompts: raw.dispatchingPrompts.slice(0, 8).map(value => {
        const prompt = record(value);
        const id = display(prompt.id, 1000), timestamp = display(prompt.timestamp, 100);
        const { text, mentions, media, sender } = chatDisplayContent({
          id, timestamp, kind: 'user', content: typeof prompt.prompt === 'string' ? prompt.prompt : '',
        });
        return {
          id, timestamp, text, ...(mentions?.length ? { mentions } : {}), ...(sender ? { sender } : {}),
          // A pending prompt can reference uploaded files. Native inline media
          // is read using the eventual transcript item ID.
          ...(media?.some(ref => !ref.inline) ? { media: media.filter(ref => !ref.inline) } : {}),
        };
      }),
    } : {}),
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
