export const SESSION_MENTION_DRAG_TYPE = 'application/x-elevenex-session';

export interface SessionMentionCandidate {
  sessionId: number;
  title: string;
  branch: string;
  status: string;
}

export interface SessionMention {
  sessionId: number;
  title: string;
  provider: string;
  providerSessionId: string | null;
  branch: string;
  status: string;
  transcriptExportPath: string;
  contextMarkdown: string;
  omittedTurns: number;
  generatedAt: string;
}
