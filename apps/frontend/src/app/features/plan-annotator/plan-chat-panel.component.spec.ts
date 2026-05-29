import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import type { PlanChatFork, Session } from '@/shared/models/session.model';
import { PlanChatPanelComponent, sanitizePlanChatUserContent } from './plan-chat-panel.component';
import { PlanChatService } from './plan-chat.service';
import type { PlanReviewRequest } from './plan-review.model';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 22,
    repoId: 1,
    projectId: 1,
    branchName: 'main',
    worktreePath: '/tmp/project',
    name: 'Plan Q&A',
    surface: 'embedded_plan_chat',
    status: 'created',
    activeAgentProvider: 'codex',
    claudeSessionId: '-1',
    codexSessionId: 'codex-child',
    hasInjectedWorktreeContext: false,
    hasUnreviewedCompletion: false,
    lastCompletionAt: null,
    lastCompletionKind: null,
    lastStateChangeAt: null,
    createdAt: '2026-05-29T10:00:00.000Z',
    updatedAt: '2026-05-29T10:00:00.000Z',
    ...overrides,
  };
}

function makePlanChat(overrides: Partial<PlanChatFork> = {}): PlanChatFork {
  return {
    id: 5,
    parentSessionId: 11,
    childSessionId: 22,
    provider: 'codex',
    reviewId: 'transcript-plan:msg-1',
    anchorMessageId: 'msg-1',
    anchorMessageKind: 'assistant',
    anchorExcerpt: 'Plan',
    planExcerpt: '# Plan',
    childSession: makeSession(),
    createdAt: '2026-05-29T10:00:00.000Z',
    updatedAt: '2026-05-29T10:00:00.000Z',
    ...overrides,
  };
}

function makeReview(): PlanReviewRequest {
  return {
    provider: 'codex',
    source: 'transcript-plan',
    sessionId: 11,
    reviewId: 'transcript-plan:msg-1',
    messageId: 'msg-1',
    anchorMessageId: 'msg-1',
    anchorMessageKind: 'assistant',
    planMarkdown: '# Plan\n\nDo this.',
    createdAt: '2026-05-29T10:00:00.000Z',
  };
}

describe('PlanChatPanelComponent', () => {
  it('strips server guard text from displayed user questions', () => {
    expect(
      sanitizePlanChatUserContent(
        '<elevenex-plan-chat>\n<elevenex_plan_question>\nWhat changes?\n</elevenex_plan_question>\n</elevenex-plan-chat>',
      ),
    ).toBe('What changes?');
  });

  it('creates or reuses a hidden chat and submits the first question in place', async () => {
    const events$ = new Subject<any>();
    const planChat = makePlanChat();
    const planChatsMock = {
      getByReview: vi.fn(() => of([])),
      ensure: vi.fn(() => of({ planChat, session: planChat.childSession })),
      submitQuestion: vi.fn(() =>
        of({ planChat, session: planChat.childSession, question: 'What changes?' }),
      ),
      delete: vi.fn(),
    };
    const websocketMock = {
      connect: vi.fn(() => events$.asObservable()),
      send: vi.fn(),
      disconnect: vi.fn(),
    };
    const agentApiMock = {
      getHistory: vi.fn(() => of([])),
    };

    await TestBed.configureTestingModule({
      imports: [PlanChatPanelComponent],
      providers: [
        { provide: PlanChatService, useValue: planChatsMock },
        { provide: AgentRuntimeWebsocketService, useValue: websocketMock },
        { provide: AgentRuntimeApiService, useValue: agentApiMock },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(PlanChatPanelComponent);
    const review = makeReview();
    fixture.componentRef.setInput('review', review);
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentInstance.draft.set('What changes?');
    await fixture.componentInstance.sendQuestion(review);

    expect(planChatsMock.ensure).toHaveBeenCalledWith(11, {
      reviewId: 'transcript-plan:msg-1',
      anchorMessageId: 'msg-1',
      anchorMessageKind: 'assistant',
      planMarkdown: '# Plan\n\nDo this.',
    });
    expect(planChatsMock.submitQuestion).toHaveBeenCalledWith(11, 5, {
      question: 'What changes?',
    });
    expect(websocketMock.connect).toHaveBeenCalledWith(22, 'codex');
    expect(websocketMock.send).toHaveBeenCalledWith(22, { type: 'hydrate' }, 'codex');
  });
});
