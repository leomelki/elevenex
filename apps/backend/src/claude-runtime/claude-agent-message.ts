/** Match a whole provider envelope so quoted examples remain human prompts. */
export function claudeAgentMessageContent(text: string): string | null {
  const envelope = text
    .trimEnd()
    .match(
      /^(?:[ \t]*\r?\n)*(?:Another Claude session sent a message:\s*\r?\n)?<agent-message\s+([^<>]+)>([\s\S]*)<\/agent-message>$/,
    );
  if (!envelope) return null;
  const sender = envelope[1].match(
    /(?:^|\s)from=(?:"([^"<>]+)"|'([^'<>]+)')(?=\s|$)/,
  );
  const author = (sender?.[1] ?? sender?.[2])?.trim();
  const body = envelope[2].trim();
  if (!author || !body) return null;
  const kind = body.startsWith('[Subagent hand-back]')
    ? 'a final response'
    : 'a message';
  return `Received ${kind} from ${author}.\n\n${body}`;
}
