import type { SessionAgentReference, SessionAgentSender } from '@elevenex/shared';
import { sessionAgentProvider, type SessionProviderColumns } from './session-provider.js';

const legacyAssignmentContext = "Work within the brief's scope and file ownership. Follow repository instructions and coordinate writes to the shared checkout. Complete the assignment directly unless the brief calls for further delegation. Report your result, changed files, checks run and blockers in your final reply.";
export const DELEGATED_ASSIGNMENT_CONTEXT = 'Complete the assignment directly unless it calls for further delegation. Your final reply is the result returned to the parent. Follow the requested reply format and report changed files, checks and blockers when relevant.';
const assignmentHeaders = [DELEGATED_ASSIGNMENT_CONTEXT, legacyAssignmentContext].map(context => `${context}\n\n`);

type SessionIdentity = SessionProviderColumns & {
  id: number;
  name?: string | null;
  workspaceId?: number | null;
  agentSelection?: { provider: string; model?: string | null; reasoningEffort?: string | null } | null;
};

export function sessionAgentReference(session: SessionIdentity): SessionAgentReference {
  const provider = sessionAgentProvider(session).slice(0, 80);
  const selection = session.agentSelection?.provider === provider ? session.agentSelection : undefined;
  return {
    sessionId: session.id,
    ...(session.workspaceId ? { taskId: session.workspaceId } : {}),
    ...(session.name ? { title: session.name.slice(0, 300) } : {}),
    selection: {
      provider,
      ...(selection?.model ? { model: selection.model.slice(0, 160) } : {}),
      ...(selection?.reasoningEffort ? { effort: selection.reasoningEffort.slice(0, 80) } : {}),
    },
  };
}

/** The harness retains the authenticated sender alongside the prompt in saved history. */
export function sessionAgentPrompt(text: string, session: SessionAgentReference, purpose: SessionAgentSender['purpose'], messageId?: string): string {
  const label = purpose === 'assignment' ? 'delegation' : 'session message';
  const sender = JSON.stringify({ ...session, messageId }).replace(/[<>]/g, character => character === '<' ? '\\u003c' : '\\u003e');
  return '[Elevenex ' + label + ' from session #' + session.sessionId + ']\n<elevenex_sender>' + sender + '</elevenex_sender>\n\n' + text;
}

const prefix = /^\[Elevenex (delegation|session message) from session #([1-9]\d{0,15})\]\r?\n(?:<elevenex_sender>([^\r\n]{1,4096})<\/elevenex_sender>\r?\n)?\r?\n/;
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function field(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;
}

/** Restore the sender, including prompts already saved with the original header. */
export function splitSessionAgentPrompt(text: string): { text: string; sender?: SessionAgentSender } {
  if (!text.startsWith('[Elevenex ')) return { text };
  const match = prefix.exec(text);
  if (!match) return { text };
  const sessionId = Number(match[2]);
  if (!positive(sessionId)) return { text };
  let session: SessionAgentReference = { sessionId };
  let messageId: string | undefined;
  if (match[3]) {
    try {
      const saved = JSON.parse(match[3]) as (Partial<SessionAgentReference> & { messageId?: unknown }) | null;
      if (saved?.sessionId !== sessionId) return { text };
      const provider = field(saved.selection?.provider, 80);
      if (typeof saved.messageId === 'string' && /^[a-f0-9-]{36}$/.test(saved.messageId)) messageId = saved.messageId;
      session = {
        sessionId,
        taskId: positive(saved.taskId) ? saved.taskId : undefined,
        title: field(saved.title, 300),
        selection: provider ? { provider, model: field(saved.selection?.model, 160), effort: field(saved.selection?.effort, 80) } : undefined,
      };
    } catch {
      return { text };
    }
  }
  const purpose = match[1] === 'delegation' ? 'assignment' : 'message';
  const brief = text.slice(match[0].length);
  const assignmentHeader = purpose === 'assignment' ? assignmentHeaders.find(header => brief.startsWith(header)) : undefined;
  return {
    text: assignmentHeader ? brief.slice(assignmentHeader.length) : brief,
    sender: { session, purpose, ...(messageId ? { messageId } : {}) },
  };
}
