import type { ConversationMentionResult } from './conversation-export.service.js';

const SESSION_MENTION_TAG = 'elevenex_session_mention';

/** Keep the chat mention wire format so the transcript renders these as cards. */
export function serializeSessionMention(
  mention: ConversationMentionResult,
): string {
  const escapeTag = (value: string) =>
    value.replace(
      new RegExp(`</${SESSION_MENTION_TAG}>`, 'gi'),
      `<\\/${SESSION_MENTION_TAG}>`,
    );
  const metadata = (value: string) =>
    escapeTag(value.replace(/\s+/g, ' ').trim());
  return [
    `<${SESSION_MENTION_TAG}>`,
    `Session: ${metadata(mention.title)}`,
    `Session ID: ${mention.sessionId}`,
    `Provider: ${metadata(mention.provider)}`,
    ...(mention.providerSessionId
      ? [`Provider session ID: ${metadata(mention.providerSessionId)}`]
      : []),
    `Branch: ${metadata(mention.branch)}`,
    `Status: ${metadata(mention.status)}`,
    `Transcript export: ${metadata(mention.transcriptExportPath)}`,
    'Use the compact snapshot below for context. Read or grep the transcript export only if more detail is needed.',
    '',
    escapeTag(mention.contextMarkdown),
    `</${SESSION_MENTION_TAG}>`,
  ].join('\n');
}
