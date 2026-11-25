import type { SessionAgentReference, SessionAgentSelection, SessionChatChangedFile, SessionChatWorkStatus } from '@elevenex/shared';
import type { Status } from '../../ui';

export type AgentWorkTarget =
  | { readonly kind: 'session'; readonly session: SessionAgentReference }
  | { readonly kind: 'native'; readonly agentId: string };

export interface AgentWorkIntent {
  readonly target: AgentWorkTarget;
  readonly action: 'open' | 'answer' | 'message' | 'stop' | 'return';
  readonly itemId?: string;
  readonly origin?: HTMLElement;
}

export function agentControl(event: Event): HTMLElement | undefined {
  return event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
}

export interface AgentWorkMessage {
  readonly id: string;
  readonly text: string;
  readonly status: 'Sending…' | 'Queued' | 'Delivered' | 'Unconfirmed' | 'Failed';
}

export interface AgentWorkCard {
  readonly id: string;
  readonly title: string;
  readonly selection?: SessionAgentSelection;
  readonly role?: string;
  readonly status: SessionChatWorkStatus;
  readonly detail: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly usage?: string;
  readonly target?: AgentWorkTarget;
  readonly ownSession?: true;
  readonly stoppable?: boolean;
  readonly messages?: readonly AgentWorkMessage[];
}

export interface AgentWorkBoard {
  readonly agents: readonly AgentWorkCard[];
  readonly wait?: string;
  readonly waiting?: boolean;
}

export interface AgentWorkReply {
  readonly session: SessionAgentReference;
  readonly replyId: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly files?: readonly SessionChatChangedFile[];
  readonly totalFiles?: number;
  readonly sharedChanges?: boolean;
}

export interface AgentWorkAction {
  readonly label: string;
  readonly detail?: string;
  readonly status?: string;
  readonly target?: AgentWorkTarget;
}

export function sessionAgentTitle(session: SessionAgentReference): string {
  return session.title || 'Session ' + session.sessionId;
}

const harnessLabels: Readonly<Record<string, string>> = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi',
};
export function agentIdentity(selection?: SessionAgentSelection, includeHarness = false): string {
  if (!selection) return '';
  const harness = harnessLabels[selection.provider] ?? selection.provider;
  const effort = selection.effort;
  return [includeHarness || !selection.model ? harness : '', selection.model,
    effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : ''].filter(Boolean).join(' · ');
}

export function agentWorkState(status: SessionChatWorkStatus): { glyph: Status; label: string } {
  switch (status) {
    case 'pending': return { glyph: 'queued', label: 'Starting' };
    case 'running': return { glyph: 'running', label: 'Running' };
    case 'waiting': return { glyph: 'attention', label: 'Needs you' };
    case 'paused': return { glyph: 'queued', label: 'Paused' };
    case 'completed': return { glyph: 'done', label: 'Done' };
    case 'error': return { glyph: 'failed', label: 'Failed' };
    case 'stopped':
    case 'interrupted': return { glyph: 'queued', label: 'Stopped' };
    case 'closed': return { glyph: 'done', label: 'Closed' };
    default: return { glyph: 'queued', label: 'Status unavailable' };
  }
}

export function agentWorkLive(status: SessionChatWorkStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'waiting' || status === 'paused';
}
