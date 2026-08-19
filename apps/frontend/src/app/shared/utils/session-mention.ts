import type { SessionMention } from '@/shared/models/session-mention.model';

export const SESSION_MENTION_TAG = 'elevenex_session_mention';

const PATTERN = new RegExp(`<${SESSION_MENTION_TAG}>([\\s\\S]*?)</${SESSION_MENTION_TAG}>`, 'g');

export interface ParsedSessionMentions {
  text: string;
  mentions: SessionMention[];
}

export function appendSessionMentions(text: string, mentions: readonly SessionMention[]): string {
  return [text.trim(), ...mentions.map(serializeSessionMention)].filter(Boolean).join('\n\n');
}

export function serializeSessionMention(mention: SessionMention): string {
  const snapshot = mention.contextMarkdown.replace(
    new RegExp(`</${SESSION_MENTION_TAG}>`, 'gi'),
    `<\\/${SESSION_MENTION_TAG}>`,
  );
  return [
    `<${SESSION_MENTION_TAG}>`,
    `Session: ${metadataValue(mention.title)}`,
    `Session ID: ${mention.sessionId}`,
    `Provider: ${metadataValue(mention.provider)}`,
    ...(mention.providerSessionId
      ? [`Provider session ID: ${metadataValue(mention.providerSessionId)}`]
      : []),
    `Branch: ${metadataValue(mention.branch)}`,
    `Status: ${metadataValue(mention.status)}`,
    `Transcript export: ${metadataValue(mention.transcriptExportPath)}`,
    'Use the compact snapshot below for context. Read or grep the transcript export only if more detail is needed.',
    '',
    snapshot,
    `</${SESSION_MENTION_TAG}>`,
  ].join('\n');
}

export function parseSessionMentions(value: string | null | undefined): ParsedSessionMentions {
  const mentions: SessionMention[] = [];
  const text = (value ?? '').replace(PATTERN, (_match, raw: string) => {
    const parsed = parseBlock(raw);
    if (parsed) mentions.push(parsed);
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), mentions };
}

function metadataValue(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`</${SESSION_MENTION_TAG}>`, 'gi'), `<\\/${SESSION_MENTION_TAG}>`)
    .trim();
}

function parseBlock(raw: string): SessionMention | null {
  const field = (name: string) =>
    raw.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.trim() ?? '';
  const session = field('Session');
  const legacyMatch = session.match(/^(.*) \(#(\d+)\)$/);
  const sessionId = Number(field('Session ID') || legacyMatch?.[2]);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return null;
  const instruction = 'Use the compact snapshot below for context. Read or grep the transcript export only if more detail is needed.';
  const contextMarkdown = raw.split(instruction, 2)[1]?.trim() ?? '';
  return {
    sessionId,
    title: legacyMatch?.[1] ?? session,
    provider: field('Provider'),
    providerSessionId: field('Provider session ID') || null,
    branch: field('Branch'),
    status: field('Status'),
    transcriptExportPath: field('Transcript export'),
    contextMarkdown,
    omittedTurns: 0,
    generatedAt: '',
  };
}
