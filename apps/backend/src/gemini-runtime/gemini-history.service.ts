import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { canonicalizeAgentTool } from '../agent-runtime/agent-tool-normalization.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import { stripSessionContext } from './gemini-transcript.js';

/** A materialized Gemini chat file. */
export interface GeminiChatFile {
  path: string;
  sessionId: string | null;
  messages: Record<string, unknown>[];
  /** Everything except `messages`, preserved so a fork can rewrite the file. */
  header: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads Gemini CLI's on-disk conversation files.
 *
 * Layout (verified against gemini-cli 0.55):
 *
 *   ~/.gemini/projects.json                        lowercased abs path -> project name
 *   ~/.gemini/tmp/<project>/.project_root          lowercased abs path
 *   ~/.gemini/tmp/<project>/chats/session-*.jsonl  one file per session
 *
 * Each chat file is an append-only mutation log, not one-message-per-line: the
 * first line is a header (`sessionId`, `projectHash`, `startTime`, `kind`) and
 * every later line is a patch such as `{"$set":{"messages":[...]}}`. Because
 * `$set` replaces wholesale, materializing the conversation means folding the
 * patches in order and taking the final `messages` array.
 */
@Injectable()
export class GeminiHistoryService {
  private readonly logger = new Logger('GeminiHistoryService');
  private readonly geminiHome = join(homedir(), '.gemini');

  /** Resolves the chats directory Gemini uses for a given worktree. */
  async resolveChatsDir(worktreePath: string): Promise<string | null> {
    const target = worktreePath.toLowerCase();
    try {
      const raw = await fs.readFile(
        join(this.geminiHome, 'projects.json'),
        'utf8',
      );
      const parsed = asRecord(JSON.parse(raw));
      const projects = asRecord(parsed?.['projects']);
      if (projects) {
        for (const [path, name] of Object.entries(projects)) {
          if (path.toLowerCase() === target && typeof name === 'string') {
            return join(this.geminiHome, 'tmp', name, 'chats');
          }
        }
      }
    } catch {
      // Fall through to the directory scan below.
    }

    // projects.json may not list the worktree yet (or may be missing entirely),
    // so fall back to the `.project_root` marker each tmp directory carries.
    try {
      const entries = await fs.readdir(join(this.geminiHome, 'tmp'), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const root = await fs.readFile(
            join(this.geminiHome, 'tmp', entry.name, '.project_root'),
            'utf8',
          );
          if (root.trim().toLowerCase() === target) {
            return join(this.geminiHome, 'tmp', entry.name, 'chats');
          }
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Finds the chat file whose header carries `sessionId`. */
  async findChatFile(
    worktreePath: string,
    sessionId: string,
  ): Promise<GeminiChatFile | null> {
    const chatsDir = await this.resolveChatsDir(worktreePath);
    if (!chatsDir) return null;

    let names: string[];
    try {
      names = await fs.readdir(chatsDir);
    } catch {
      return null;
    }

    // The filename embeds the session id's first segment, so check those first
    // instead of parsing every file in a long-lived project.
    const shortId = sessionId.split('-')[0] ?? '';
    const ordered = [
      ...names.filter((name) => shortId && name.includes(shortId)),
      ...names.filter((name) => !shortId || !name.includes(shortId)),
    ];

    for (const name of ordered) {
      if (!name.endsWith('.jsonl')) continue;
      const file = await this.readChatFile(join(chatsDir, name));
      if (file?.sessionId === sessionId) return file;
    }
    return null;
  }

  /** Folds a chat file's patch log into its final state. */
  async readChatFile(path: string): Promise<GeminiChatFile | null> {
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf8');
    } catch {
      return null;
    }

    const state: Record<string, unknown> = {};
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = asRecord(parsed);
      if (!record) continue;

      const set = asRecord(record['$set']);
      if (set) {
        Object.assign(state, set);
        continue;
      }
      const push = asRecord(record['$push']);
      if (push) {
        for (const [key, value] of Object.entries(push)) {
          const existing = Array.isArray(state[key])
            ? (state[key] as unknown[])
            : [];
          state[key] = [...existing, value];
        }
        continue;
      }
      // The header line (and any future plain-object line) merges directly.
      if (!('$set' in record) && !('$push' in record)) {
        Object.assign(state, record);
      }
    }

    const messages = Array.isArray(state['messages'])
      ? (state['messages'] as unknown[])
          .map(asRecord)
          .filter((message): message is Record<string, unknown> =>
            Boolean(message),
          )
      : [];
    const header = { ...state };
    delete header['messages'];

    return {
      path,
      sessionId:
        typeof state['sessionId'] === 'string' ? state['sessionId'] : null,
      messages,
      header,
    };
  }

  /** Rewrites a chat file with a new session id and a truncated message list. */
  async writeChatFile(
    path: string,
    header: Record<string, unknown>,
    messages: Record<string, unknown>[],
  ): Promise<void> {
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({ ...header, lastUpdated: now }),
      JSON.stringify({ $set: { messages, lastUpdated: now } }),
    ];
    await fs.writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  }

  /**
   * Converts materialized Gemini messages into shared transcript items.
   *
   * Gemini stores messages in its API's `Content` shape: a `role`-ish `type`
   * plus a `content`/`parts` array whose entries are text, `functionCall` or
   * `functionResponse`. Anything unrecognized is skipped rather than rendered
   * as an empty bubble.
   */
  toTranscript(messages: Record<string, unknown>[]): ClaudeTranscriptItem[] {
    const items: ClaudeTranscriptItem[] = [];

    for (const [index, message] of messages.entries()) {
      const id =
        typeof message['id'] === 'string' ? message['id'] : `gemini-${index}`;
      const timestamp =
        typeof message['timestamp'] === 'string'
          ? message['timestamp']
          : new Date(0).toISOString();
      const role = this.resolveRole(message);
      const parts = this.resolveParts(message);

      for (const [partIndex, part] of parts.entries()) {
        const partId = partIndex === 0 ? id : `${id}-${partIndex}`;

        const functionCall = asRecord(part['functionCall']);
        if (functionCall) {
          const name =
            typeof functionCall['name'] === 'string'
              ? functionCall['name']
              : 'Tool';
          const canonical = canonicalizeAgentTool(name, functionCall['args']);
          items.push({
            id: partId,
            kind: 'tool_use',
            toolUseId: partId,
            toolName: canonical.toolDisplayName,
            providerToolName: name,
            toolKind: canonical.toolKind,
            toolDisplayName: canonical.toolDisplayName,
            toolInput: canonical.toolInput,
            providerToolInput: functionCall['args'],
            timestamp,
          });
          continue;
        }

        const functionResponse = asRecord(part['functionResponse']);
        if (functionResponse) {
          items.push({
            id: partId,
            kind: 'tool_result',
            toolUseId:
              typeof functionResponse['id'] === 'string'
                ? functionResponse['id']
                : partId,
            content: this.stringifyResponse(functionResponse['response']),
            timestamp,
          });
          continue;
        }

        const text = typeof part['text'] === 'string' ? part['text'] : '';
        if (!text.trim()) continue;

        // Gemini flags reasoning parts with `thought: true`.
        if (part['thought'] === true) {
          items.push({
            id: partId,
            kind: 'thinking',
            content: text,
            timestamp,
          });
          continue;
        }

        const content = role === 'user' ? stripSessionContext(text) : text;
        if (!content) continue;
        items.push({
          id: partId,
          kind: role,
          contentType: 'message',
          content,
          timestamp,
        });
      }
    }

    return items;
  }

  private resolveRole(message: Record<string, unknown>): 'user' | 'assistant' {
    const raw = message['type'] ?? message['role'];
    return typeof raw === 'string' && raw.toLowerCase() === 'user'
      ? 'user'
      : 'assistant';
  }

  private resolveParts(
    message: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const source = Array.isArray(message['content'])
      ? message['content']
      : Array.isArray(message['parts'])
        ? message['parts']
        : [];
    return (source as unknown[])
      .map((part) =>
        typeof part === 'string' ? { text: part } : asRecord(part),
      )
      .filter((part): part is Record<string, unknown> => Boolean(part));
  }

  private stringifyResponse(response: unknown): string {
    if (typeof response === 'string') return response;
    const record = asRecord(response);
    const output = record?.['output'] ?? record?.['result'];
    if (typeof output === 'string') return output;
    try {
      return JSON.stringify(response ?? '', null, 2);
    } catch {
      return '';
    }
  }
}
