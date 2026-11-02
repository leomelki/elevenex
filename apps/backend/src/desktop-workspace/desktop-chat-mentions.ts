import { BadRequestException } from '@nestjs/common';
import type { ConversationExportService } from '../agent-runtime/conversation-export.service.js';
import { serializeSessionMention } from '../agent-runtime/session-mention.js';

/** Resolve identities on this backend only; never accept renderer-supplied snapshots or paths. */
export async function appendChatMentions(text: string, value: unknown, exports: ConversationExportService): Promise<string> {
  if (value === undefined) return text;
  if (!Array.isArray(value) || value.length > 8)
    throw new BadRequestException('Mention up to 8 distinct sessions.');
  const candidates: readonly unknown[] = value;
  const ids = candidates.map(id => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
      throw new BadRequestException('Mention up to 8 distinct sessions.');
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new BadRequestException('Mention up to 8 distinct sessions.');
  const blocks: string[] = [text];
  // Sequential export bounds provider work; this runs only on an explicit send.
  for (const id of ids) {
    const mention = await exports.buildMention(id);
    const contextMarkdown = mention.contextMarkdown.length > 4000
      ? mention.contextMarkdown.slice(0, 4000) + '\n[Snapshot shortened; use the transcript export for more.]'
      : mention.contextMarkdown;
    blocks.push(serializeSessionMention({ ...mention, contextMarkdown }));
  }
  const prompt = blocks.join('\n\n');
  if (prompt.length > 128000) throw new BadRequestException('Message and session context exceed the input limit.');
  return prompt;
}

/** Keep context snapshots out of the ordinary message/queue preview and its receipt identity. */
export function chatMentionText(text: string): string {
  return projectChatMentions(text).text;
}

/** Restore bounded chip identities from saved prompts without exposing context snapshots. */
export function projectChatMentions(text: string) {
  const mentions: { sessionId: number; title: string }[] = [];
  if (!text.includes('<elevenex_session_mention>')) return { text, mentions };
  const seen = new Set<number>();
  const visible = text.replace(/<elevenex_session_mention>([\s\S]*?)<\/elevenex_session_mention>/g,
    (block: string, body: string) => {
      // Only the metadata header identifies a reference; snapshot prose is untrusted.
      const header = body.trimStart().split(/\r?\n\r?\n/, 1)[0];
      const id = /^Session ID: ([1-9]\d*)\s*$/m.exec(header)?.[1];
      const sessionId = Number(id);
      if (!id || !Number.isSafeInteger(sessionId)) return block;
      const title = /^Session: ([^\r\n]*)/m.exec(header)?.[1].trim().slice(0, 1000) || `Session ${sessionId}`;
      if (!seen.has(sessionId) && mentions.length < 8) { seen.add(sessionId); mentions.push({ sessionId, title }); }
      return '';
    });
  return { text: visible.trim(), mentions };
}
