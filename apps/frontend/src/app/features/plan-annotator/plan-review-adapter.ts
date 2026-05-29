import {
  AgentToolKind,
  ClaudePermissionRequest,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import { AgentProviderId } from '@/shared/models/agent-runtime.model';
import { extractProposedPlan } from '../session/claude-workspace/util/proposed-plan';
import { PlanReviewProvider, PlanReviewRequest } from './plan-review.model';

export function planReviewFromTranscriptItem(
  item: ClaudeTranscriptItem,
  sessionId: number,
  provider: AgentProviderId,
): PlanReviewRequest | null {
  const reviewProvider = normalizeReviewProvider(provider);
  if (!reviewProvider || item.kind !== 'assistant') return null;

  if (item.contentType === 'plan' && item.content?.trim()) {
    return {
      provider: reviewProvider,
      source: 'transcript-plan',
      sessionId,
      reviewId: stableReviewId('transcript-plan', item.id),
      messageId: item.id,
      anchorMessageId: item.transcriptMessageId ?? item.sourceMessageId ?? item.id,
      anchorMessageKind: 'assistant',
      planMarkdown: item.content.trim(),
      createdAt: item.receivedAt || item.authoredAt || item.timestamp,
    };
  }

  const extraction = extractProposedPlan(item.content);
  if (!extraction?.plan.trim()) return null;

  return {
    provider: reviewProvider,
    source: 'transcript-plan',
    sessionId,
    reviewId: stableReviewId('tagged-plan', item.id),
    messageId: item.id,
    anchorMessageId: item.transcriptMessageId ?? item.sourceMessageId ?? item.id,
    anchorMessageKind: 'assistant',
    planMarkdown: extraction.plan,
    before: extraction.before || undefined,
    after: extraction.after || undefined,
    createdAt: item.receivedAt || item.authoredAt || item.timestamp,
  };
}

export function planReviewFromPermissionRequest(
  request: ClaudePermissionRequest | null | undefined,
  sessionId: number,
  provider: AgentProviderId,
): PlanReviewRequest | null {
  const reviewProvider = normalizeReviewProvider(provider);
  if (!reviewProvider || !request || !isExitPlanTool(request.toolName, request.toolKind)) return null;

  const input = asRecord(request.input);
  const providerInput = asRecord(request.providerInput);
  const plan = stringField(input, 'plan') || stringField(providerInput, 'plan');
  if (!plan.trim()) return null;

  return {
    provider: reviewProvider,
    source: 'exit-plan-permission',
    sessionId,
    reviewId: stableReviewId('exit-plan', request.requestId),
    requestId: request.requestId,
    planMarkdown: plan.trim(),
    planFilePath:
      stringField(input, 'planFilePath')
      || stringField(providerInput, 'planFilePath')
      || undefined,
    createdAt: request.createdAt,
  };
}

export function planReviewFromExitPlanToolCall(
  item: ClaudeTranscriptItem,
  sessionId: number,
  provider: AgentProviderId,
): PlanReviewRequest | null {
  const reviewProvider = normalizeReviewProvider(provider);
  if (!reviewProvider || item.kind !== 'tool_use' || !isExitPlanTool(item.toolName, item.toolKind)) {
    return null;
  }

  const input = asRecord(item.toolInput);
  const providerInput = asRecord(item.providerToolInput);
  const plan = stringField(input, 'plan') || stringField(providerInput, 'plan');
  if (!plan.trim()) return null;

  return {
    provider: reviewProvider,
    source: 'exit-plan-permission',
    sessionId,
    reviewId: stableReviewId('exit-plan-history', item.id),
    messageId: item.id,
    planMarkdown: plan.trim(),
    planFilePath:
      stringField(input, 'planFilePath')
      || stringField(providerInput, 'planFilePath')
      || undefined,
    createdAt: item.receivedAt || item.authoredAt || item.timestamp,
    readonly: true,
  };
}

export function isSamePlanReview(a: PlanReviewRequest | null, b: PlanReviewRequest | null): boolean {
  return !!a && !!b && a.sessionId === b.sessionId && a.reviewId === b.reviewId;
}

export function normalizeReviewProvider(provider: AgentProviderId): PlanReviewProvider | null {
  return provider === 'codex' || provider === 'claude' ? provider : null;
}

function stableReviewId(prefix: string, id: string): string {
  return `${prefix}:${id}`;
}

function isExitPlanTool(toolName: string | undefined, toolKind: AgentToolKind | undefined): boolean {
  if (toolKind === 'exit_plan_mode') return true;
  return (toolName ?? '').toLowerCase().replace(/[_\-\s]/g, '') === 'exitplanmode';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field : '';
}
