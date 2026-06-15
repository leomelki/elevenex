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

function makeReview(overrides: Partial<PlanReviewRequest> = {}): PlanReviewRequest {
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
    ...overrides,
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
      reviewSource: 'transcript-plan',
      anchorMessageId: 'msg-1',
      anchorMessageKind: 'assistant',
      permissionRequestId: undefined,
      toolUseId: undefined,
      planMarkdown: '# Plan\n\nDo this.',
    });
    expect(planChatsMock.submitQuestion).toHaveBeenCalledWith(11, 5, {
      question: 'What changes?',
    });
    expect(websocketMock.connect).toHaveBeenCalledWith(22, 'codex');
    expect(websocketMock.send).toHaveBeenCalledWith(22, { type: 'hydrate' }, 'codex');
  });

  it('keeps a streaming second answer visible when a stale history refresh completes', async () => {
    const events$ = new Subject<any>();
    const planChat = makePlanChat();

    // First exchange: the question and its persisted answer (sourceMessageId m1).
    const q1 = {
      id: 'h-q1',
      kind: 'user',
      content: '<elevenex_plan_question>First?</elevenex_plan_question>',
      timestamp: '2026-05-29T10:00:01.000Z',
    };
    const a1History = {
      id: 'm1:assistant:0',
      kind: 'assistant',
      content: 'First answer',
      timestamp: '2026-05-29T10:00:02.000Z',
      sourceMessageId: 'm1',
    };
    // Live copies: the first answer (now persisted) and a second answer still
    // streaming (sourceMessageId m2) that history does not know about yet.
    const a1Live = { ...a1History, id: 'm1:0' };
    const a2Live = {
      id: 'm2:0',
      kind: 'assistant',
      content: 'Second answer',
      timestamp: '2026-05-29T10:00:04.000Z',
      sourceMessageId: 'm2',
    };

    const planChatsMock = {
      getByReview: vi.fn(() => of([planChat])),
      ensure: vi.fn(),
      submitQuestion: vi.fn(),
      delete: vi.fn(),
    };
    const websocketMock = {
      connect: vi.fn(() => events$.asObservable()),
      send: vi.fn(),
      disconnect: vi.fn(),
    };
    // The first run's refresh only sees the first answer — the second is unpersisted.
    const agentApiMock = {
      getHistory: vi.fn(() => of([q1, a1History])),
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
    fixture.componentRef.setInput('review', makeReview());
    fixture.detectChanges();
    await fixture.whenStable();

    const component = fixture.componentInstance;
    // Both answers are present live when the first run's stale refresh fires.
    component.historyItems.set([q1, a1History] as never);
    component.liveItems.set([a1Live, a2Live] as never);

    events$.next({ type: 'complete', payload: { sessionId: 22 } });
    await fixture.whenStable();
    fixture.detectChanges();

    // The persisted first answer is dropped from live; the in-flight second answer survives.
    expect(component.liveItems().map((item) => item.id)).toEqual(['m2:0']);

    const assistants = component.visibleItems().filter((item) => item.kind === 'assistant');
    expect(assistants.filter((item) => item.sourceMessageId === 'm1')).toHaveLength(1);
    expect(assistants.some((item) => item.content === 'Second answer')).toBe(true);
  });

  it('submits questions for a pending ExitPlanMode review without a saved transcript anchor', async () => {
    const events$ = new Subject<any>();
    const planChat = makePlanChat({
      reviewId: 'exit-plan:perm-1',
      anchorMessageId: 'plan-review:exit-plan:perm-1',
    });
    const planChatsMock = {
      getByReview: vi.fn(() => of([])),
      ensure: vi.fn(() => of({ planChat, session: planChat.childSession })),
      submitQuestion: vi.fn(() =>
        of({ planChat, session: planChat.childSession, question: 'Why this order?' }),
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
    const review = makeReview({
      source: 'exit-plan-permission',
      reviewId: 'exit-plan:perm-1',
      requestId: 'perm-1',
      toolUseId: 'tool-1',
      anchorMessageId: undefined,
      anchorMessageKind: undefined,
    });
    fixture.componentRef.setInput('review', review);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.canAsk(review)).toBe(true);

    fixture.componentInstance.draft.set('Why this order?');
    await fixture.componentInstance.sendQuestion(review);

    expect(planChatsMock.ensure).toHaveBeenCalledWith(11, {
      reviewId: 'exit-plan:perm-1',
      reviewSource: 'exit-plan-permission',
      anchorMessageId: undefined,
      anchorMessageKind: undefined,
      permissionRequestId: 'perm-1',
      toolUseId: 'tool-1',
      planMarkdown: '# Plan\n\nDo this.',
    });
    expect(planChatsMock.submitQuestion).toHaveBeenCalledWith(11, 5, {
      question: 'Why this order?',
    });
  });
});
