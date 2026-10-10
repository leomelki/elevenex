import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { codexWebSearchInput } from './codex-web-search.js';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { canonicalizeAgentTool } from '../agent-runtime/agent-tool-normalization.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import type { CodexHistorySessionSummary } from './codex-runtime.types.js';
import type { AgentForkConversationRequest } from '../agent-runtime/agent-runtime.types.js';
import { TranscriptFileCache } from '../agent-runtime/transcript-file-cache.js';

type JsonRecord = Record<string, unknown>;

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
  private readonly historyCache = new TranscriptFileCache<
    ClaudeTranscriptItem[]
  >();
  private readonly sessionPaths = new Map<string, string>();
  private readonly pathSearches = new Map<string, Promise<string | null>>();
  private fileScan: Promise<string[]> | null = null;

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
    const path = await this.findSessionFile(codexSessionId);
    if (!path) {
      return [];
    }
    return this.historyCache.read(path, async () =>
      this.normalizeRecords(await this.readJsonl(path)),
    );
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
    throw new Error('Codex fork history is not ready. Please try again.');
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
    for (const [index, record] of records.entries()) {
      const timestamp =
        stringValue(record.timestamp) ?? new Date().toISOString();
      if (this.isVisibleUserMessage(record)) {
        const content = this.extractUserMessageText(record);
        if (content) {
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
      }
    }
    return items;
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
      const canonicalTool = canonicalizeAgentTool(toolName, providerToolInput);
      return {
        id: `${id}:tool_use`,
        kind: 'tool_use',
        toolUseId,
        toolName,
        providerToolName: toolName,
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
      const records: JsonRecord[] = await this.readJsonl(path).catch(() => []);
      if (
        records.some((record) => {
          const payload = asRecord(record.payload);
          return record.type === 'session_meta' && payload?.id === sessionId;
        })
      ) {
        return path;
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

  private async readJsonl(path: string): Promise<JsonRecord[]> {
    const content = await fs.readFile(path, 'utf-8');
    const records = content
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as JsonRecord;
        } catch {
          return { type: 'parse_error', id: randomUUID() };
        }
      });
    return this.applyRollbacks(records);
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
