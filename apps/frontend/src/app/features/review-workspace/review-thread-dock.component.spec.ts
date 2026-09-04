import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewChatsService } from '@/shared/services/review-chats.service';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import type { ReviewChat } from '@/shared/models/review-chat.model';
import { ReviewThreadDockComponent } from './review-thread-dock.component';
import {
  ReviewWorkspaceStateService,
  SESSION_TAB_ID,
} from './review-workspace-state.service';

function chat(overrides: Partial<ReviewChat> = {}): ReviewChat {
  return {
    id: 7,
    parentSessionId: 1,
    childSessionId: 42,
    provider: 'claude',
    title: 'a.ts:10',
    mode: 'readonly',
    status: 'open',
    scope: 'branch',
    filePath: 'src/a.ts',
    anchors: [],
    changeHash: null,
    fingerprint: null,
    anchorMessageId: 'msg-1',
    anchorMessageKind: 'assistant',
    turnKey: null,
    promotedForkId: null,
    lastReadAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ReviewThreadDockComponent inherited context', () => {
  let component: ReviewThreadDockComponent;
  let fixture: ComponentFixture<ReviewThreadDockComponent>;
  let state: ReviewWorkspaceStateService;
  let deleteSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    deleteSpy = vi.fn(() => of({ id: 7, deleted: true }));
    await TestBed.configureTestingModule({
      imports: [ReviewThreadDockComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ReviewChatsService,
          useValue: { list: vi.fn(() => of([])), delete: deleteSpy },
        },
        {
          provide: AgentRuntimeWebsocketService,
          useValue: { borrow: vi.fn(() => of()), releaseBorrow: vi.fn(), send: vi.fn() },
        },
        {
          provide: AgentRuntimeApiService,
          useValue: {
            getHistory: vi.fn(() => of([])),
            getAutocompleteItems: vi.fn(() => of([])),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ReviewThreadDockComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('sessionId', 1);
    fixture.componentRef.setInput('provider', 'claude');

    state = TestBed.inject(ReviewWorkspaceStateService);
    state.reset();
  });

  it('tells the user a discussion already carries the session conversation', () => {
    state.chats.set([chat()]);
    state.activeThreadId.set(7);

    const note = component.contextNote();
    expect(note?.summary).toBe('Continues from your session');
    // The fork is a snapshot, so the note must not promise a live view.
    expect(note?.caveat).toContain('when this discussion started');
  });

  it('shows no inherited-context note on the session tab', () => {
    state.chats.set([chat()]);
    state.activeThreadId.set(SESSION_TAB_ID);

    expect(component.contextNote()).toBeNull();
  });

  it('renders the tab menu outside the scrolling tab strip, which clips it', () => {
    state.chats.set([chat()]);
    fixture.detectChanges();

    const tab = fixture.nativeElement.querySelector('.rd-tab-wrap') as HTMLElement;
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(component.menuOpenFor()).toBe(7);
    // Inside .rd-tabs the menu would be clipped to the strip's ~30px height.
    expect(fixture.nativeElement.querySelector('.rd-tabs .rd-menu')).toBeNull();
    expect(document.querySelector('.cdk-overlay-container .rd-menu')).not.toBeNull();
  });

  it('deletes the discussion once the confirmation dialog is accepted', async () => {
    await state.load(1);
    state.chats.set([chat()]);
    fixture.detectChanges();

    const removePromise = component.remove(chat());
    await Promise.resolve();
    fixture.detectChanges();

    // The confirm dialog has no zContent, which used to crash on open
    // (NG0919) because the dialog tried to attach a portal for `undefined`.
    const okButton = document.querySelector<HTMLButtonElement>('[data-testid="z-ok-button"]');
    expect(okButton).not.toBeNull();
    okButton?.click();

    await removePromise;

    expect(deleteSpy).toHaveBeenCalledWith(1, 7);
    expect(state.chats().some((c) => c.id === 7)).toBe(false);
  });
});
