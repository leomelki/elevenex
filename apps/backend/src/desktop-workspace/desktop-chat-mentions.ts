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
  if (!text.includes('<elevenex_session_mention>')) return text;
  return text.replace(/<elevenex_session_mention>([\s\S]*?)<\/elevenex_session_mention>/g,
    (block: string, body: string) => /^Session ID: [1-9]\d*\s*$/m.test(body) ? '' : block).trim();
}
