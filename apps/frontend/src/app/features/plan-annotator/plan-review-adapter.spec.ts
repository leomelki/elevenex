import { describe, expect, it } from 'vitest';
import {
  planReviewFromPermissionRequest,
  planReviewFromTranscriptItem,
} from './plan-review-adapter';
import { ClaudePermissionRequest, ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';

describe('plan-review-adapter', () => {
  it('creates a review from Codex native plan transcript items', () => {
    const item: ClaudeTranscriptItem = {
      id: 'plan-1',
      kind: 'assistant',
      contentType: 'plan',
      content: '# Plan\n\nDo this.',
      timestamp: '2026-05-22T10:00:00.000Z',
    };

    expect(planReviewFromTranscriptItem(item, 7, 'codex')).toMatchObject({
      provider: 'codex',
      source: 'transcript-plan',
      sessionId: 7,
      reviewId: 'transcript-plan:plan-1',
      planMarkdown: '# Plan\n\nDo this.',
      messageId: 'plan-1',
      anchorMessageId: 'plan-1',
      anchorMessageKind: 'assistant',
    });
  });

  it('creates a review from tagged proposed plans', () => {
    const item: ClaudeTranscriptItem = {
      id: 'msg-1',
      kind: 'assistant',
      content: 'Read this first.\n<proposed_plan>\n# Plan\nDo it\n</proposed_plan>\nDone.',
      timestamp: '2026-05-22T10:00:00.000Z',
    };

    expect(planReviewFromTranscriptItem(item, 7, 'codex')).toMatchObject({
      provider: 'codex',
      source: 'transcript-plan',
      reviewId: 'tagged-plan:msg-1',
      planMarkdown: '# Plan\nDo it',
      anchorMessageId: 'msg-1',
      anchorMessageKind: 'assistant',
      before: 'Read this first.',
      after: 'Done.',
    });
  });

  it('uses transcript source ids as plan chat anchors when present', () => {
    const item: ClaudeTranscriptItem = {
      id: 'rendered-msg-1',
      kind: 'assistant',
      contentType: 'plan',
      content: '# Plan\n\nDo this.',
      sourceMessageId: 'provider-msg-1',
      timestamp: '2026-05-22T10:00:00.000Z',
    };

    expect(planReviewFromTranscriptItem(item, 7, 'codex')).toMatchObject({
      reviewId: 'transcript-plan:rendered-msg-1',
      anchorMessageId: 'provider-msg-1',
      anchorMessageKind: 'assistant',
    });
  });

  it('creates a review from Claude Code ExitPlanMode permission requests', () => {
    const request: ClaudePermissionRequest = {
      requestId: 'perm-1',
      toolUseId: 'tool-1',
      toolName: 'ExitPlanMode',
      toolKind: 'exit_plan_mode',
      input: { plan: '# Plan\nDo it', planFilePath: '.claude/plans/a.md' },
      createdAt: '2026-05-22T10:00:00.000Z',
    };

    expect(planReviewFromPermissionRequest(request, 9, 'claude')).toMatchObject({
      provider: 'claude',
      source: 'exit-plan-permission',
      sessionId: 9,
      requestId: 'perm-1',
      planMarkdown: '# Plan\nDo it',
      planFilePath: '.claude/plans/a.md',
    });
  });

  it('rejects malformed plan sources', () => {
    expect(planReviewFromTranscriptItem({
      id: 'msg-1',
      kind: 'assistant',
      content: 'regular message',
      timestamp: '2026-05-22T10:00:00.000Z',
    }, 7, 'codex')).toBeNull();

    expect(planReviewFromPermissionRequest({
      requestId: 'perm-1',
      toolUseId: 'tool-1',
      toolName: 'ExitPlanMode',
      input: {},
      createdAt: '2026-05-22T10:00:00.000Z',
    }, 7, 'claude')).toBeNull();
  });
});
