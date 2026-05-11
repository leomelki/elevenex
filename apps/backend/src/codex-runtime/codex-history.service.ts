import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import type { CodexHistorySessionSummary } from './codex-runtime.types.js';

type JsonRecord = Record<string, unknown>;

@Injectable()
export class CodexHistoryService {
  private readonly logger = new Logger('CodexHistoryService');
  private readonly sessionsRoot = join(homedir(), '.codex', 'sessions');

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
    const records = await this.readJsonl(path);
    return this.normalizeRecords(records);
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
        id = stringValue(payload?.id) ?? id;
        cwd = stringValue(payload?.cwd) ?? cwd;
        model =
          stringValue(payload?.model) ??
          stringValue(payload?.model_provider) ??
          model;
      }
      if (this.isVisibleUserMessage(record)) {
        const rawMessage = stringValue(asRecord(record.payload)?.message);
        latestUserMessage = rawMessage
          ? this.stripInjectedWorktreeContext(rawMessage)
          : latestUserMessage;
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
        const payload = asRecord(record.payload);
        const rawContent = stringValue(payload?.message);
        if (rawContent) {
          items.push({
            id: `codex-history:${index}:user`,
            kind: 'user',
            content: this.stripInjectedWorktreeContext(rawContent),
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
      const normalized = this.normalizeResponseItem(
        payloadItem,
        timestamp,
        index,
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
      return {
        id: `${id}:tool_use`,
        kind: 'tool_use',
        toolUseId,
        toolName,
        toolInput: this.normalizeToolInput(
          rawToolName,
          item.arguments ?? item.input,
        ),
        sourceMessageId: id,
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
        timestamp,
        authoredAt: timestamp,
      };
    }
    return null;
  }

  private isVisibleUserMessage(record: JsonRecord): boolean {
    if (record.type !== 'event_msg') {
      return false;
    }
    const payload = asRecord(record.payload);
    return (
      payload?.type === 'user_message' &&
      (!payload.kind || payload.kind === 'plain') &&
      Boolean(stringValue(payload.message))
    );
  }

  private normalizeToolName(name: string): string {
    if (name === 'shell_command') {
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
    if (toolName === 'shell_command') {
      return {
        command:
          stringValue(args?.command) ??
          stringValue(args?.cmd) ??
          stringValue(args?.input) ??
          (typeof value === 'string' ? value : ''),
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
    const paths = await this.findJsonlFiles(this.sessionsRoot);
    return (
      paths.find((path) => basename(path).includes(sessionId)) ??
      (await this.findFileBySessionMeta(paths, sessionId))
    );
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
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' ? (value as JsonRecord) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
