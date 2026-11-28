import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SESSION_CHAT_PROMPT_LIMIT, parseBrowserElements, serializeBrowserElements } from '@elevenex/shared';
import type { AgentRuntimeProvider, AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { uploadedAttachment } from './desktop-chat-media.js';
import { splitChatMentions } from './desktop-chat-mentions.js';
import { record } from './desktop-chat-projection.js';
import { splitSessionAgentPrompt } from '../sessions/session-agent-message.js';

export function editableChatPrompt(item: AgentTranscriptItem): boolean {
  return item.kind === 'user' && !!item.sourceMessageId && !!item.content?.trim() &&
    !item.isSynthetic && !item.parentToolUseId && !item.editUnsupported &&
    !splitSessionAgentPrompt(item.content ?? '').sender;
}

export function validateChatEditId(itemId: unknown): string {
  if (typeof itemId !== 'string' || !itemId.trim() || itemId.length > 1000 || itemId.includes('\0'))
    throw new BadRequestException('Invalid prompt ID.');
  return itemId;
}

export function assertChatEditIdle(raw: Record<string, unknown>): void {
  if (raw.canInterrupt || raw.runPhase === 'running' || raw.runPhase === 'waiting' ||
      raw.pendingPermissionRequest || raw.pendingUserInputRequest ||
      (Array.isArray(raw.backgroundWork) && raw.backgroundWork.length) ||
      (Array.isArray(raw.subagents) && raw.subagents.some(agent => record(agent).status === 'started')))
    throw new ConflictException('Wait for the current turn and background work to finish before editing.');
  if ((Array.isArray(raw.pendingPrompts) && raw.pendingPrompts.length) ||
      (Array.isArray(raw.dispatchingPrompts) && raw.dispatchingPrompts.length))
    throw new ConflictException('Resolve queued messages before editing this conversation.');
}

export function chatEditProvider(provider: AgentRuntimeProvider) {
  if (!provider.info.capabilities.rewindConversation || !provider.rewindConversation)
    throw new BadRequestException('This harness does not support editing sent messages.');
  return provider.rewindConversation.bind(provider);
}

export function savedChatPrompt(
  history: readonly AgentTranscriptItem[],
  itemId: string,
  providerSession: readonly unknown[],
) {
  const index = history.findLastIndex(item => item.id === itemId);
  const anchor = history[index];
  if (!anchor?.sourceMessageId || !editableChatPrompt(anchor))
    throw new ConflictException('This message is no longer available to edit.');
  const sourceId = anchor.sourceMessageId;
  // Some providers save text and image parts under one user message ID.
  const parts = [...new Map(history.filter(item => item.kind === 'user' && item.sourceMessageId === sourceId &&
    !item.isSynthetic && !item.parentToolUseId)
    .map(item => [item.id, item])).values()];
  if (parts.some(item => item.editUnsupported))
    throw new BadRequestException('This message contains context the harness cannot resend.');
  const original = parts.map(item => item.content).filter(Boolean).join('\n\n');
  const images = parts.flatMap(item => item.images ?? []);
  const mentions = splitChatMentions(original);
  const browser = parseBrowserElements(mentions.text);
  const attachments: string[] = [];
  const text = browser.text.split('\n').filter(line => {
    const link = /^\[[^\]\r\n]+\]\(<([^>\r\n]+)>\)\s*$/.exec(line);
    if (!link || !uploadedAttachment(link[1])) return true;
    attachments.push(line.trimEnd());
    return false;
  }).join('\n').trim();
  if (text.length > SESSION_CHAT_PROMPT_LIMIT)
    throw new BadRequestException('This message exceeds the edit limit of 64,000 characters.');
  const context = [serializeBrowserElements(browser.elements), ...attachments, ...mentions.blocks].filter(Boolean);
  const later = new Set<string>();
  let end: AgentTranscriptItem | undefined;
  let total = 0;
  for (const [position, item] of history.entries()) {
    if (item.kind === 'assistant' || (item.kind === 'user' && !item.isSynthetic)) {
      end = item;
      total++;
    }
    if (position > index && item.kind === 'user' && !item.isSynthetic && item.sourceMessageId !== sourceId)
      later.add(item.sourceMessageId ?? item.id);
  }
  const revision = createHash('sha256').update(JSON.stringify([
    providerSession, itemId, sourceId, anchor.timestamp, original, end?.id, end?.content, total,
  ])).digest('hex');
  return { sourceId, text, context, images, revision, laterPrompts: later.size };
}
