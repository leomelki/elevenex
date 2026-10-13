import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { codexWebSearchInput } from './codex-web-search.js';
import { promises as fs } from 'fs';
import { createReadStream } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { createInterface } from 'readline';
import { setTimeout as delay } from 'timers/promises';
import { canonicalizeAgentTool } from '../agent-runtime/agent-tool-normalization.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import type { CodexHistorySessionSummary } from './codex-runtime.types.js';
import type { AgentForkConversationRequest } from '../agent-runtime/agent-runtime.types.js';
import { TranscriptFileCache } from '../agent-runtime/transcript-file-cache.js';
import {
  CodexSubagentTracker,
  collaborationTool,
  delegatedTaskNames,
  record,
  readableText,
  textValue,
} from './codex-subagents.js';
import type { ClaudeSubagentState } from '../claude-runtime/claude-runtime.types.js';
import { codexContextUsage } from './codex-context-usage.js';
import {
  codexAsyncQuestionAnswers,
  codexAsyncQuestionCall,
  codexAsyncQuestionResult,
} from './codex-async-questions.js';

type JsonRecord = Record<string, unknown>;

export interface CodexHistoryTurn {
  id: string;
  status: string;
  items: { type: string }[];
}

export interface CodexRewindTarget {
  threadId: string;
  beforeTurnId: string;
}

export interface CodexForkTarget {
  threadId: string;
  lastTurnId?: string;
  beforeTurnId?: string;
  draft: string | null;
  anchorExcerpt: string | null;
}

export const CODEX_HISTORY_SESSIONS_ROOT = Symbol(
  'CODEX_HISTORY_SESSIONS_ROOT',
);

@Injectable()
export class CodexHistoryService {
  private readonly logger = new Logger('CodexHistoryService');
  private readonly sessionsRoot: string;
  private readonly sessionPaths = new Map<string, string>();
  private readonly pathSearches = new Map<string, Promise<string | null>>();
  private fileScan: Promise<string[]> | null = null;
  private readonly subagentCache = new TranscriptFileCache<{
    bytes: number;
    history: ClaudeTranscriptItem[];
    records: JsonRecord[];
    displayName?: string;
    agentType?: string;
    agentPath?: string;
    model?: string;
    reasoningEffort?: string;
    contextUsage?: ClaudeSubagentState['contextUsage'];
    contextUsageUpdatedAt?: string;
  }>();
  private childMetadata = new Map<string, Map<string, string>>();
  private childMetadataAt = 0;
  private childMetadataScan: Promise<void> | null = null;

  constructor(
    @Optional()
    @Inject(CODEX_HISTORY_SESSIONS_ROOT)
    sessionsRoot?: string,
  ) {
    this.sessionsRoot = sessionsRoot ?? join(homedir(), '.codex', 'sessions');
  }

  async getHistory(
    codexSessionId: string | null,
  ): Promise<ClaudeTranscriptItem[]> {
    if (!codexSessionId || codexSessionId === '-1') {
      return [];
    }
    return (await this.getSubagentSnapshot(codexSessionId))?.history ?? [];
  }

  async getSubagentSnapshot(threadId: string, prompt?: string) {
    const path = await this.findSessionFile(threadId);
    if (!path) return null;
    const snapshot = await this.subagentCache.read(
      path,
      async () => {
        let bytes = 0;
        const records = await this.readJsonl(path, (size) => {
          bytes = size;
        });
        const metaRecord = records.find(
          (entry) => entry.type === 'session_meta',
        );
        const meta = record(metaRecord?.payload);
        const spawn = record(
          record(record(meta.source).subagent ?? record(meta.source).subAgent)
            .thread_spawn,
        );
        const normalized = this.normalizeRecords(records);
        const childStartedAt = textValue(spawn.parent_thread_id)
          ? textValue(metaRecord?.timestamp)
          : undefined;
        const context = record(
          [...records]
            .reverse()
            .find(
              (entry) =>
                entry.type === 'turn_context' &&
                (!childStartedAt ||
                  (textValue(entry.timestamp) ?? '') >= childStartedAt),
            )?.payload,
        );
        const history = childStartedAt
          ? normalized.filter((item) => item.timestamp >= childStartedAt)
          : normalized;
        const ownRecords = childStartedAt
          ? records.filter(
              (entry) => (textValue(entry.timestamp) ?? '') >= childStartedAt,
            )
          : records;
        let usageModel: string | null = null;
        let contextUsage: ClaudeSubagentState['contextUsage'];
        let contextUsageUpdatedAt: string | undefined;
        for (const entry of ownRecords) {
          const payload = record(entry.payload);
          if (entry.type === 'turn_context')
            usageModel = textValue(payload.model) ?? usageModel;
          if (entry.type !== 'event_msg' || payload.type !== 'token_count')
            continue;
          const info = record(payload.info);
          if (!Object.keys(record(info.last_token_usage)).length) continue;
          contextUsage = codexContextUsage(
            usageModel,
            info.last_token_usage,
            info.model_context_window,
          );
          contextUsageUpdatedAt = textValue(entry.timestamp);
        }
        return {
          bytes,
          history,
          records: ownRecords,
          displayName: textValue(meta.agent_nickname ?? spawn.agent_nickname),
          agentType: textValue(meta.agent_role ?? spawn.agent_role),
          agentPath: textValue(meta.agent_path ?? spawn.agent_path),
          model: textValue(context.model),
          reasoningEffort: textValue(
            context.effort ?? context.reasoning_effort,
          ),
          contextUsage,
          contextUsageUpdatedAt,
        };
      },
      (snapshot) => snapshot.bytes,
    );
    // A forked child can inherit its parent's conversation. Start at its own assignment.
    const ownPromptIndex = prompt
      ? snapshot.history.findIndex(
          (item) =>
            item.kind === 'user' && item.content?.trim() === prompt.trim(),
        )
      : -1;
    const history =
      ownPromptIndex >= 0
        ? snapshot.history.slice(ownPromptIndex)
        : snapshot.history;
    const tracker = new CodexSubagentTracker();
    const taskNames = delegatedTaskNames(history);
    if (taskNames.length) await this.indexChildMetadata();
    tracker.restore(
      history,
      threadId,
      threadId,
      this.childMetadata.get(threadId),
    );
    // Some CLI versions persist collaboration as event_msg rather than function calls.
    for (const entry of snapshot.records) {
      if (entry.type !== 'event_msg') continue;
      const raw = record(entry.payload);
      const timestamp = textValue(entry.timestamp) ?? '';
      if (ownPromptIndex >= 0 && timestamp < history[0].timestamp) continue;
      const receiver = textValue(raw.new_thread_id ?? raw.receiver_thread_id);
      if (raw.type === 'collab_agent_spawn_end' && receiver) {
        tracker.collaboration(
          {
            id: raw.call_id,
            tool: 'spawnAgent',
            senderThreadId: threadId,
            receiverThreadIds: [receiver],
            prompt: raw.prompt,
            model: raw.model,
            agentsStates: { [receiver]: { status: raw.status } },
          },
          timestamp,
          threadId,
        );
      } else if (raw.type === 'collab_waiting_end') {
        for (const [id, status] of Object.entries(record(raw.statuses))) {
          tracker.collaboration(
            { tool: 'wait', agentsStates: { [id]: { status } } },
            timestamp,
            threadId,
          );
        }
      } else if (raw.type === 'item_completed') {
        const activity = record(raw.item);
        const id = textValue(activity.agent_thread_id);
        if (
          activity.type === 'SubAgentActivity' &&
          id &&
          tracker.agents.has(id)
        ) {
          const status =
            activity.kind === 'completed'
              ? 'completed'
              : activity.kind === 'interrupted'
                ? 'interrupted'
                : activity.kind === 'started'
                  ? 'running'
                  : undefined;
          if (status)
            tracker.upsert(id, { executionStatus: status }, timestamp);
        }
      }
    }
    const lastTurn = [...snapshot.records]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'event_msg' &&
          [
            'task_started',
            'task_complete',
            'task_completed',
            'turn_aborted',
          ].includes(String(record(entry.payload).type)),
      );
    const lastTurnType = record(lastTurn?.payload).type;
    return {
      history,
      subagents: [...tracker.agents.values()],
      displayName: snapshot.displayName,
      agentType: snapshot.agentType,
      agentPath: snapshot.agentPath,
      model: snapshot.model,
      reasoningEffort: snapshot.reasoningEffort,
      contextUsage: snapshot.contextUsage,
      contextUsageUpdatedAt: snapshot.contextUsageUpdatedAt,
      path,
      executionStatus: (lastTurnType === 'task_started'
        ? 'running'
        : lastTurnType === 'turn_aborted'
          ? 'interrupted'
          : lastTurn
            ? 'completed'
            : undefined) as ClaudeSubagentState['executionStatus'],
      timestamp: textValue(lastTurn?.timestamp),
      updatedAt: history.at(-1)?.timestamp,
      lastAssistantMessage: [...history]
        .reverse()
        .find((item) => item.kind === 'assistant' && item.content)?.content,
    };
  }

  /** Index only the first rollout record, with bounded IO; never parse every session transcript. */
  private indexChildMetadata(): Promise<void> {
    if (Date.now() - this.childMetadataAt < 30_000) return Promise.resolve();
    if (this.childMetadataScan) return this.childMetadataScan;
    const scan = (async () => {
      const paths = await (this.fileScan ??
        this.findJsonlFiles(this.sessionsRoot));
      const index = new Map<string, Map<string, string>>();
      for (let cursor = 0; cursor < paths.length; cursor += 8) {
        await Promise.all(
          paths.slice(cursor, cursor + 8).map(async (path) => {
            let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
            try {
              handle = await fs.open(path, 'r');
              // session_meta is a small first record. Ignore oversized/unrelated records.
              let buffer = Buffer.alloc(4096);
              let { bytesRead } = await handle.read(
                buffer,
                0,
                buffer.length,
                0,
              );
              if (
                !buffer.subarray(0, bytesRead).includes(10) &&
                bytesRead === buffer.length
              ) {
                buffer = Buffer.alloc(128 * 1024);
                ({ bytesRead } = await handle.read(
                  buffer,
                  0,
                  buffer.length,
                  0,
                ));
              }
              const content = buffer.subarray(0, bytesRead).toString('utf8');
              const newline = content.indexOf('\n');
              if (newline < 0 && bytesRead === buffer.length) return;
              const entry = record(
                JSON.parse(newline < 0 ? content : content.slice(0, newline)),
              );
              if (entry.type !== 'session_meta') return;
              const meta = record(entry.payload);
              const spawn = record(
                record(
                  record(meta.source).subagent ?? record(meta.source).subAgent,
                ).thread_spawn,
              );
              const parent = textValue(spawn.parent_thread_id),
                id = textValue(meta.id),
                name = textValue(spawn.agent_path);
              if (!parent || !id || !name) return;
              const aliases = index.get(parent) ?? new Map<string, string>();
              aliases.set(name, id);
              aliases.set(name.split('/').at(-1)!, id);
              index.set(parent, aliases);
              if (this.sessionPaths.size >= 512)
                this.sessionPaths.delete(
                  this.sessionPaths.keys().next().value!,
                );
              this.sessionPaths.set(id, path);
            } catch {
              /* A rollout can be removed or still be receiving its first record. */
            } finally {
              await handle?.close();
            }
          }),
        );
      }
      this.childMetadata = index;
      this.childMetadataAt = Date.now();
    })().finally(() => {
      if (this.childMetadataScan === scan) this.childMetadataScan = null;
    });
    this.childMetadataScan = scan;
    return scan;
  }

  /** Do not publish a fork until its rollout contains the retained turns. */
  async waitForHistory(
    threadId: string,
    expectedUserMessages: number,
    rolloutPath?: string,
  ): Promise<ClaudeTranscriptItem[]> {
    const deadline = Date.now() + 5_000;
    do {
      const path = rolloutPath ?? (await this.findSessionFile(threadId));
      if (path) {
        try {
          const history = this.normalizeRecords(await this.readJsonl(path));
          if (
            history.filter((item) => item.kind === 'user').length ===
            expectedUserMessages
          ) {
            return history;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await delay(50);
    } while (Date.now() < deadline);
    throw new ServiceUnavailableException(
      'Codex fork history is not ready. Please try again.',
    );
  }

  /** Paginated thread/read can omit turns; rollout events still record boundaries. */
  async getThreadTurns(threadId: string): Promise<CodexHistoryTurn[]> {
    const path = await this.findSessionFile(threadId);
    if (!path) throw new NotFoundException('Codex thread file not found.');
    const turns = new Map<string, CodexHistoryTurn>();
    let current: CodexHistoryTurn | undefined;
    for (const entry of await this.readJsonl(path)) {
      const payload = record(entry.payload);
      const id = textValue(payload.turn_id ?? payload.turnId);
      if (
        id &&
        (entry.type === 'turn_context' ||
          (entry.type === 'event_msg' && payload.type === 'task_started') ||
          this.isVisibleUserMessage(entry))
      ) {
        current = turns.get(id);
        if (!current) {
          current = { id, status: 'inProgress', items: [] };
          turns.set(id, current);
        }
      }
      if (!current) continue;
      if (id && id !== current.id) continue;
      if (this.isVisibleUserMessage(entry))
        current.items.push({ type: 'userMessage' });
      if (entry.type === 'event_msg') {
        if (
          payload.type === 'task_complete' ||
          payload.type === 'task_completed'
        )
          current.status = 'completed';
        else if (payload.type === 'turn_aborted')
          current.status = 'interrupted';
      }
    }
    return [...turns.values()];
  }

  async forkHistory(
    codexSessionId: string | null,
    request: AgentForkConversationRequest,
  ): Promise<CodexForkTarget> {
    if (!request.anchorMessageId || !request.anchorMessageKind) {
      throw new BadRequestException('A Codex fork anchor message is required.');
    }
    const anchorMessageId = request.anchorMessageId;
    const anchorMessageKind = request.anchorMessageKind;
    if (!codexSessionId || codexSessionId === '-1') {
      throw new NotFoundException('Codex thread not found.');
    }

    const path = await this.findSessionFile(codexSessionId);
    if (!path) {
      throw new NotFoundException('Codex thread file not found.');
    }

    const records = await this.readJsonl(path);
    const targetIndex = records.findIndex((record, index) =>
      this.isForkAnchorRecord(
        record,
        index,
        anchorMessageId,
        anchorMessageKind,
      ),
    );
    if (targetIndex === -1) {
      throw new NotFoundException('Message not found in Codex thread.');
    }

    const target = records[targetIndex];
    const draft =
      anchorMessageKind === 'user' ? this.extractUserMessageText(target) : null;
    const anchorExcerpt =
      anchorMessageKind === 'user'
        ? draft
        : this.extractAssistantMessageText(target);
    const turnId = this.findOwningTurnId(records, targetIndex);
    if (!turnId) {
      throw new BadRequestException(
        'Could not identify the Codex turn for this message.',
      );
    }

    return {
      threadId: codexSessionId,
      ...(anchorMessageKind === 'user'
        ? { beforeTurnId: turnId }
        : { lastTurnId: turnId }),
      draft,
      anchorExcerpt,
    };
  }

  async rewindHistory(
    codexSessionId: string | null,
    messageId: string,
  ): Promise<CodexRewindTarget> {
    const trimmedMessageId = messageId.trim();
    if (!trimmedMessageId) {
      throw new BadRequestException('A messageId is required.');
    }
    if (!codexSessionId || codexSessionId === '-1') {
      throw new NotFoundException('Codex thread not found.');
    }

    const path = await this.findSessionFile(codexSessionId);
    if (!path) {
      throw new NotFoundException('Codex thread file not found.');
    }

    const records = await this.readJsonl(path);
    const targetIndex = records.findIndex(
      (_record, index) => this.recordAnchorId(index) === trimmedMessageId,
    );
    if (targetIndex === -1) {
      throw new NotFoundException('Message not found in Codex thread.');
    }
    if (!this.isVisibleUserMessage(records[targetIndex])) {
      throw new BadRequestException('Only user messages can be edited.');
    }

    const beforeTurnId = this.findOwningTurnId(records, targetIndex);
    if (!beforeTurnId) {
      throw new BadRequestException(
        'Could not identify the Codex turn for this message.',
      );
    }

    return { threadId: codexSessionId, beforeTurnId };
  }

  async listSessions(): Promise<CodexHistorySessionSummary[]> {
    const paths = await this.findJsonlFiles(this.sessionsRoot);
    const summaries = await Promise.all(
      paths.map((path) =>
        this.parseSessionSummary(path).catch((error) => {
          this.logger.debug(
            `Could not parse Codex session ${path}: ${String(error)}`,
          );
          return null;
        }),
      ),
    );
    return summaries
      .filter((item): item is CodexHistorySessionSummary => Boolean(item))
      .sort((left, right) =>
        (right.lastTimestamp ?? '').localeCompare(left.lastTimestamp ?? ''),
      );
  }

  private async parseSessionSummary(
    path: string,
  ): Promise<CodexHistorySessionSummary | null> {
    const records = await this.readJsonl(path);
    let id: string | null = null;
    let cwd: string | null = null;
    let model: string | null = null;
    let lastTimestamp: string | null = null;
    let latestUserMessage: string | null = null;
    let messageCount = 0;

    for (const record of records) {
      const timestamp = stringValue(record.timestamp);
      if (timestamp) {
        lastTimestamp = timestamp;
      }
      if (record.type === 'session_meta') {
        const payload = asRecord(record.payload);
        // Fork rollouts can also contain the parent's session_meta record.
        id ??= stringValue(payload?.id) ?? null;
        cwd = stringValue(payload?.cwd) ?? cwd;
        model =
          stringValue(payload?.model) ??
          stringValue(payload?.model_provider) ??
          model;
      }
      if (this.isVisibleUserMessage(record)) {
        latestUserMessage =
          this.extractUserMessageText(record) || latestUserMessage;
        messageCount += 1;
      }
    }

    if (!id) {
      id = basename(path, '.jsonl');
    }
    return {
      id,
      cwd,
      model,
      summary: latestUserMessage,
      messageCount,
      lastTimestamp,
      path,
    };
  }

  private normalizeRecords(records: JsonRecord[]): ClaudeTranscriptItem[] {
    const items: ClaudeTranscriptItem[] = [];
    const asyncQuestions = new Map<string, ClaudeTranscriptItem>();
    const answeredQuestions = new Map<string, ClaudeTranscriptItem>();
    const responseMessageIds = new Set(
      records.flatMap((entry) => {
        const payload = record(entry.payload);
        return entry.type === 'response_item' &&
          payload.type === 'message' &&
          payload.role === 'assistant' &&
          readableText(this.contentToText(payload.content))
          ? [payload.id]
          : [];
      }),
    );
    for (const [index, record] of records.entries()) {
      const timestamp =
        stringValue(record.timestamp) ?? new Date().toISOString();
      if (this.isVisibleUserMessage(record)) {
        const content = this.extractUserMessageText(record);
        if (content) {
          let response: ClaudeTranscriptItem | undefined;
          for (const [toolUseId, call] of asyncQuestions) {
            const answers = codexAsyncQuestionAnswers(call, content);
            if (!answers) continue;
            response = {
              ...codexAsyncQuestionResult(toolUseId, answers, timestamp),
              sourceMessageId: this.recordAnchorId(index),
              transcriptMessageId: this.recordAnchorId(index),
            };
            asyncQuestions.delete(toolUseId);
            answeredQuestions.set(toolUseId, response);
            break;
          }
          if (response) {
            items.push(response);
            continue;
          }
          items.push({
            id: `codex-history:${index}:user`,
            kind: 'user',
            content,
            sourceMessageId: this.recordAnchorId(index),
            transcriptMessageId: this.recordAnchorId(index),
            timestamp,
            authoredAt: timestamp,
          });
        }
        continue;
      }

      if (record.type === 'event_msg') {
        const payload = asRecord(record.payload);
        const completed = asRecord(payload?.item);
        if (
          payload?.type === 'item_completed' &&
          completed?.type === 'AgentMessage' &&
          completed.delivery === 'async' &&
          typeof completed.id === 'string' &&
          Array.isArray(completed.questions) &&
          completed.questions.length
        ) {
          // The native event often repeats a saved function call. Some
          // versions only persist the native event, so restore a call then.
          if (
            !asyncQuestions.has(completed.id) &&
            !answeredQuestions.has(completed.id)
          ) {
            const call = {
              ...codexAsyncQuestionCall(
                completed.id,
                completed.questions,
                timestamp,
              ),
              transcriptMessageId: this.recordAnchorId(index),
            };
            asyncQuestions.set(completed.id, call);
            items.push(call);
          }
          continue;
        }
        if (
          payload?.type === 'item_completed' &&
          completed?.type === 'AgentMessage' &&
          !responseMessageIds.has(completed.id)
        ) {
          const content = readableText(this.contentToText(completed.content));
          if (content)
            items.push({
              id:
                stringValue(completed.id) ?? `codex-history:${index}:assistant`,
              kind: 'assistant',
              content,
              timestamp,
              receivedAt: timestamp,
              sourceMessageId: stringValue(completed.id),
              transcriptMessageId: this.recordAnchorId(index),
            });
        }
      }
      if (record.type !== 'response_item') {
        continue;
      }
      const payload = asRecord(record.payload);
      const item =
        payload?.item ??
        (payload?.type ? payload : null) ??
        asRecord(record.item);
      const payloadItem = asRecord(item);
      if (!payloadItem) {
        continue;
      }
      if (payloadItem.type === 'web_search_call') {
        const id =
          stringValue(payloadItem.id) ??
          `codex-history:${index}:web_search_call`;
        const providerToolInput = codexWebSearchInput(payloadItem);
        const canonicalTool = canonicalizeAgentTool(
          'WebSearch',
          providerToolInput,
        );
        items.push({
          id: `${id}:tool_use`,
          kind: 'tool_use',
          toolUseId: id,
          toolName: 'WebSearch',
          providerToolName: 'WebSearch',
          ...canonicalTool,
          providerToolInput,
          sourceMessageId: id,
          transcriptMessageId: this.recordAnchorId(index),
          timestamp,
          receivedAt: timestamp,
        });
        if (payloadItem.status !== 'in_progress') {
          items.push({
            id: `${id}:tool_result`,
            kind: 'tool_result',
            toolUseId: id,
            content:
              payloadItem.status === 'failed'
                ? '<tool_use_error>Web search failed</tool_use_error>'
                : '',
            isError: payloadItem.status === 'failed',
            sourceMessageId: id,
            transcriptMessageId: this.recordAnchorId(index),
            timestamp,
            authoredAt: timestamp,
          });
        }
        continue;
      }
      const normalized = this.normalizeResponseItem(
        payloadItem,
        timestamp,
        index,
        this.recordAnchorId(index),
      );
      if (normalized) {
        items.push(normalized);
        if (
          normalized.kind === 'tool_use' &&
          normalized.providerToolName?.split('.').at(-1) ===
            'request_user_input_async' &&
          normalized.toolUseId
        )
          asyncQuestions.set(normalized.toolUseId, normalized);
      }
    }
    // Replace the delivery acknowledgement with the actual answer receipt.
    return items.filter(
      (item) =>
        item.kind !== 'tool_result' ||
        !item.toolUseId ||
        !answeredQuestions.has(item.toolUseId) ||
        answeredQuestions.get(item.toolUseId) === item,
    );
  }

  private normalizeResponseItem(
    item: JsonRecord,
    timestamp: string,
    index: number,
    transcriptMessageId: string = this.recordAnchorId(index),
  ): ClaudeTranscriptItem | null {
    const type = stringValue(item.type);
    const id =
      stringValue(item.id) ?? `codex-history:${index}:${type ?? 'item'}`;
    if (type === 'agent_message') {
      const content = readableText(this.contentToText(item.content));
      const author = stringValue(item.author);
      const routeOnly = content?.match(
        /^Message Type: (MESSAGE|FINAL_ANSWER)\s+Task name: [^\n]+\s+Sender: [^\n]+\s+Payload\s*$/,
      );
      const rendered = routeOnly
        ? `Received ${routeOnly[1] === 'FINAL_ANSWER' ? 'a final response' : 'a message'} from ${author?.split('/').at(-1)?.replace(/[_-]+/g, ' ') ?? 'another agent'}. The message body was not included in the saved transcript.`
        : content;
      return rendered
        ? {
            id,
            kind: 'system',
            content: rendered,
            timestamp,
            receivedAt: timestamp,
          }
        : null;
    }
    if (type === 'message' && item.role === 'assistant') {
      const content = this.contentToText(item.content);
      return content
        ? {
            id,
            kind: 'assistant',
            content,
            sourceMessageId: id,
            transcriptMessageId,
            timestamp,
            receivedAt: timestamp,
          }
        : null;
    }
    if (type === 'plan') {
      const content =
        stringValue(item.text) || this.contentToText(item.content);
      return content
        ? {
            id,
            kind: 'assistant',
            contentType: 'plan',
            content,
            sourceMessageId: id,
            transcriptMessageId,
            timestamp,
            receivedAt: timestamp,
          }
        : null;
    }
    if (type === 'reasoning') {
      const content =
        this.contentToText(item.summary) || this.contentToText(item.content);
      return content
        ? {
            id,
            kind: 'thinking',
            content,
            sourceMessageId: id,
            transcriptMessageId,
            timestamp,
            receivedAt: timestamp,
          }
        : null;
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      const rawToolName =
        stringValue(item.name) ?? stringValue(item.call_id) ?? type;
      const toolName = this.normalizeToolName(rawToolName);
      const toolUseId = stringValue(item.call_id) ?? id;
      const providerToolInput = this.normalizeToolInput(
        rawToolName,
        item.arguments ?? item.input,
      );
      const canonicalTool = canonicalizeAgentTool(
        collaborationTool(rawToolName) ? rawToolName : toolName,
        providerToolInput,
      );
      return {
        id: `${id}:tool_use`,
        kind: 'tool_use',
        toolUseId,
        toolName,
        providerToolName: collaborationTool(rawToolName)
          ? rawToolName
          : toolName,
        toolKind: canonicalTool.toolKind,
        toolDisplayName: canonicalTool.toolDisplayName,
        toolInput: canonicalTool.toolInput,
        providerToolInput,
        sourceMessageId: id,
        transcriptMessageId,
        timestamp,
        receivedAt: timestamp,
      };
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      return {
        id: `${id}:tool_result`,
        kind: 'tool_result',
        toolUseId: stringValue(item.call_id) ?? id,
        content:
          this.contentToText(item.output) || JSON.stringify(item.output ?? ''),
        isError: Boolean(item.error),
        sourceMessageId: id,
        transcriptMessageId,
        timestamp,
        authoredAt: timestamp,
      };
    }
    return null;
  }

  private isVisibleUserMessage(record: JsonRecord): boolean {
    return Boolean(this.extractUserMessageText(record).trim());
  }

  private isForkAnchorRecord(
    record: JsonRecord,
    index: number,
    anchorMessageId: string,
    anchorKind: 'user' | 'assistant',
  ): boolean {
    if (this.recordAnchorId(index) !== anchorMessageId) {
      return false;
    }
    if (anchorKind === 'user') {
      return this.isVisibleUserMessage(record);
    }
    return this.isVisibleAssistantMessage(record);
  }

  private isVisibleAssistantMessage(record: JsonRecord): boolean {
    if (record.type !== 'response_item') {
      return false;
    }
    const item = this.responsePayloadItem(record);
    if (!item) return false;
    const type = stringValue(item?.type);
    return (
      (type === 'message' &&
        item?.role === 'assistant' &&
        Boolean(this.contentToText(item.content))) ||
      (type === 'plan' &&
        Boolean(stringValue(item.text) || this.contentToText(item.content)))
    );
  }

  private responsePayloadItem(record: JsonRecord): JsonRecord | null {
    const payload = asRecord(record.payload);
    const item =
      payload?.item ??
      (payload?.type ? payload : null) ??
      asRecord(record.item);
    return asRecord(item);
  }

  private extractUserMessageText(record: JsonRecord): string {
    if (record.type !== 'event_msg') {
      return '';
    }
    const payload = asRecord(record.payload);
    if (
      payload?.type === 'user_message' &&
      (!payload.kind || payload.kind === 'plain')
    ) {
      return this.stripInjectedWorktreeContext(
        stringValue(payload.message) ?? '',
      );
    }

    const completedItem = asRecord(payload?.item);
    if (
      payload?.type !== 'item_completed' ||
      completedItem?.type !== 'UserMessage'
    ) {
      return '';
    }
    return this.stripInjectedWorktreeContext(
      this.contentToText(completedItem.content),
    );
  }

  private extractAssistantMessageText(record: JsonRecord): string {
    const item = this.responsePayloadItem(record);
    if (!item) return '';
    return (
      stringValue(item.text) ||
      this.contentToText(item.content) ||
      this.contentToText(item.summary)
    );
  }

  private recordAnchorId(index: number): string {
    return `codex-record:${index}`;
  }

  private findOwningTurnId(
    records: JsonRecord[],
    targetIndex: number,
  ): string | null {
    for (let index = targetIndex; index >= 0; index -= 1) {
      const record = records[index];
      const payload = asRecord(record.payload);
      const turnId = stringValue(payload?.turn_id ?? payload?.turnId);
      if (
        turnId &&
        (index === targetIndex ||
          record.type === 'turn_context' ||
          (record.type === 'event_msg' && payload?.type === 'task_started'))
      ) {
        return turnId;
      }
    }
    return null;
  }

  private normalizeToolName(name: string): string {
    if (name.split('.').at(-1) === 'spawn_agent') return 'Agent';
    if (name.split('.').at(-1) === 'request_user_input_async')
      return 'request_user_input_async';
    if (name === 'shell_command' || name === 'exec_command') {
      return 'Bash';
    }
    if (name === 'apply_patch') {
      return 'Edit';
    }
    return name;
  }

  private parseToolArguments(value: unknown): unknown {
    if (typeof value !== 'string') {
      return value ?? {};
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return { input: value };
    }
  }

  private normalizeToolInput(toolName: string, value: unknown): unknown {
    const parsed = this.parseToolArguments(value);
    const args = asRecord(parsed);
    if (collaborationTool(toolName) === 'spawn_agent')
      return {
        ...args,
        message: readableText(args?.message ?? args?.prompt),
        description:
          readableText(args?.message ?? args?.prompt) ?? args?.task_name,
        prompt: readableText(args?.message ?? args?.prompt),
        subagent_type: args?.agent_type ?? args?.subagent_type ?? 'agent',
      };
    if (toolName === 'shell_command' || toolName === 'exec_command') {
      const commandActions =
        arrayValue(args?.commandActions) ?? arrayValue(args?.command_actions);
      return {
        command:
          stringValue(args?.command) ??
          stringValue(args?.cmd) ??
          stringValue(args?.input) ??
          (typeof value === 'string' ? value : ''),
        ...(commandActions ? { commandActions } : {}),
      };
    }
    if (toolName === 'apply_patch') {
      const patch =
        stringValue(args?.patch) ??
        stringValue(args?.input) ??
        (typeof value === 'string' ? value : '');
      return this.parseApplyPatchInput(patch);
    }
    return parsed;
  }

  private parseApplyPatchInput(patch: string): Record<string, unknown> {
    const filePathMatch = patch.match(
      /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m,
    );
    return {
      file_path: filePathMatch?.[1]?.trim() ?? '',
      old_string: '',
      new_string: patch,
    };
  }

  private contentToText(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value
        .map((part) => {
          if (typeof part === 'string') return part;
          const record = asRecord(part);
          return (
            stringValue(record?.text) ?? stringValue(record?.content) ?? ''
          );
        })
        .filter(Boolean)
        .join('\n');
    }
    if (value == null) {
      return '';
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  private stripInjectedWorktreeContext(text: string): string {
    const trimmed = text.trimStart();
    const openTag = '<elevenex-worktree-context>';
    const closeTag = '</elevenex-worktree-context>';
    if (!trimmed.startsWith(openTag)) {
      return text;
    }
    const closingIndex = trimmed.indexOf(closeTag);
    if (closingIndex === -1) {
      return text;
    }
    const afterClose = trimmed.slice(closingIndex + closeTag.length);
    return afterClose.replace(/^\s+/, '');
  }

  private async findSessionFile(sessionId: string): Promise<string | null> {
    const cached = this.sessionPaths.get(sessionId);
    if (cached) {
      try {
        await fs.access(cached);
        return cached;
      } catch {
        this.sessionPaths.delete(sessionId);
      }
    }
    const existing = this.pathSearches.get(sessionId);
    if (existing) return existing;
    const search = (async () => {
      // Opening several tabs must not launch duplicate recursive scans.
      const scan = (this.fileScan ??= this.findJsonlFiles(this.sessionsRoot));
      let paths: string[];
      try {
        paths = await scan;
      } finally {
        if (this.fileScan === scan) this.fileScan = null;
      }
      const path =
        paths.find((candidate) => basename(candidate).includes(sessionId)) ??
        (await this.findFileBySessionMeta(paths, sessionId));
      if (path) {
        if (this.sessionPaths.size >= 512) {
          this.sessionPaths.delete(this.sessionPaths.keys().next().value!);
        }
        this.sessionPaths.set(sessionId, path);
      }
      // Missing files are deliberately not cached: newly created forks and
      // rollouts may appear immediately after this lookup.
      return path;
    })();
    this.pathSearches.set(sessionId, search);
    try {
      return await search;
    } finally {
      if (this.pathSearches.get(sessionId) === search)
        this.pathSearches.delete(sessionId);
    }
  }

  private async findFileBySessionMeta(
    paths: string[],
    sessionId: string,
  ): Promise<string | null> {
    for (const path of paths) {
      // Inspect physical metadata only: inherited parent metadata must never
      // resolve a parent id to its child's rollout or recurse during lookup.
      const stream = createReadStream(path);
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          const meta = this.parseJsonl(line)[0];
          if (
            meta.type === 'session_meta' &&
            record(meta.payload).id === sessionId
          )
            return path;
          break;
        }
      } catch {
        // A rollout can disappear or still be writing its first record.
      } finally {
        lines.close();
        stream.destroy();
      }
    }
    return null;
  }

  private async findJsonlFiles(root: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const nested = await Promise.all(
        entries.map(async (entry) => {
          const path = join(root, entry.name);
          if (entry.isDirectory()) {
            return this.findJsonlFiles(path);
          }
          return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : [];
        }),
      );
      return nested.flat();
    } catch {
      return [];
    }
  }

  private async readJsonl(
    path: string,
    measureBytes?: (bytes: number) => void,
  ): Promise<JsonRecord[]> {
    const { records, bytes } = await this.readInheritedRecords(path);
    measureBytes?.(bytes);
    return this.applyRollbacks(records);
  }

  private async readInheritedRecords(
    path: string,
    ancestors = new Set<string>(),
    endByteOffset?: number,
  ): Promise<{ records: JsonRecord[]; bytes: number }> {
    if (ancestors.has(path)) {
      throw new BadRequestException(
        'Codex fork history contains an invalid parent chain.',
      );
    }
    const seen = ancestors.add(path);
    let content: Buffer;
    if (endByteOffset === undefined) {
      content = await fs.readFile(path);
    } else if (endByteOffset === 0) {
      content = Buffer.alloc(0);
    } else {
      // The fork freezes a byte prefix. Do not load later turns from a large,
      // still-growing parent or split a Unicode record by a character offset.
      const chunks: Buffer[] = [];
      for await (const chunk of createReadStream(path, {
        end: endByteOffset - 1,
      }))
        chunks.push(chunk as Buffer);
      content = Buffer.concat(chunks);
      if (content.length !== endByteOffset)
        throw new BadRequestException(
          'Codex fork parent history is incomplete.',
        );
    }
    const records = this.parseJsonl(content.toString('utf8'));
    const metaIndex = records.findIndex(
      (entry) => entry.type === 'session_meta',
    );
    const meta = record(records[metaIndex]?.payload);
    const base = record(meta.history_base);
    if (!Object.keys(base).length) return { records, bytes: content.length };
    const parentId = textValue(base.thread_id);
    const ordinal = base.end_ordinal_exclusive;
    const offset = base.end_byte_offset;
    if (
      !parentId ||
      typeof ordinal !== 'number' ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new BadRequestException(
        'Codex fork history has an invalid parent boundary.',
      );
    }
    const parentPath = await this.findSessionFile(parentId);
    if (!parentPath)
      throw new NotFoundException('Codex fork parent history not found.');
    const inherited = await this.readInheritedRecords(parentPath, seen, offset);
    const prefix = inherited.records.filter(
      (entry) => typeof entry.ordinal === 'number' && entry.ordinal < ordinal,
    );
    // Keep the child's metadata first for identity, while stable logical
    // record positions preserve edit/fork anchors as its own file grows.
    return {
      records: [
        records[metaIndex],
        ...prefix,
        ...records.filter((_entry, index) => index !== metaIndex),
      ],
      bytes: content.length + inherited.bytes,
    };
  }

  private parseJsonl(content: string): JsonRecord[] {
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as JsonRecord;
        } catch {
          return { type: 'parse_error', id: randomUUID() };
        }
      });
  }

  private applyRollbacks(records: JsonRecord[]): JsonRecord[] {
    const turns: { index: number; id: string | null }[] = [];
    for (const [index, record] of records.entries()) {
      const payload = asRecord(record.payload);
      if (
        record.type === 'event_msg' &&
        payload?.type === 'thread_rolled_back'
      ) {
        const count = payload.num_turns;
        if (typeof count === 'number' && Number.isInteger(count) && count > 0) {
          const removed = turns.splice(Math.max(0, turns.length - count));
          if (removed.length) {
            // Keep physical record positions stable: UI edit/fork anchors use them.
            for (let cursor = removed[0].index; cursor <= index; cursor += 1) {
              records[cursor] = { type: 'rolled_back' };
            }
          }
        }
        continue;
      }
      const turnId = stringValue(payload?.turn_id ?? payload?.turnId);
      if (
        turnId &&
        (record.type === 'turn_context' ||
          (record.type === 'event_msg' && payload?.type === 'task_started'))
      ) {
        if (turns.at(-1)?.id !== turnId) turns.push({ index, id: turnId });
      } else if (
        this.isVisibleUserMessage(record) &&
        (!turns.length || turns.at(-1)?.id === null)
      ) {
        // Older rollouts can lack turn boundary events entirely.
        turns.push({ index, id: null });
      }
    }
    return records;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' ? (value as JsonRecord) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
