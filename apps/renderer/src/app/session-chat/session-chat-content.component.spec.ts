import { TestBed } from '@angular/core/testing';
import { SessionChatClient } from '../backend/session-chat-client.service';
import { SessionChatContentComponent } from './session-chat-content.component';

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })));
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
it('opens an uncached page only when reachable and retains the loaded page through an outage', async () => {
  const client = { content: vi.fn(async () => ({ ok: true, value: { itemId: 'item', part: 'text', offset: 0, text: 'Already loaded text', nextOffset: 100, total: 200 } })), cancel: vi.fn() };
  TestBed.configureTestingModule({ providers: [{ provide: SessionChatClient, useValue: client }] });
  const fixture = TestBed.createComponent(SessionChatContentComponent);
  fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1, sessionId: 2 }); fixture.componentRef.setInput('itemId', 'item'); fixture.componentRef.setInput('unreachable', 'dev-box');
  fixture.detectChanges(); await fixture.whenStable(); expect(client.content).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('Opens when dev-box is back');
  fixture.componentRef.setInput('unreachable', undefined); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  expect(document.querySelector('ex-session-chat-content pre, .cdk-overlay-container pre')?.textContent).toContain('Already loaded text');
  fixture.componentRef.setInput('unreachable', 'dev-box'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  expect(document.querySelector('ex-session-chat-content pre, .cdk-overlay-container pre')?.textContent).toContain('Already loaded text');
  fixture.componentInstance.part.set('input'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  expect(document.body.textContent).toContain('Opens when dev-box is back'); expect(client.content).toHaveBeenCalledOnce();
  fixture.componentInstance.returnToLoaded(); fixture.detectChanges(); expect(document.querySelector('ex-session-chat-content pre, .cdk-overlay-container pre')?.textContent).toContain('Already loaded text');
});

it('returns to a paired loaded output while input is unreachable and resets scroll on a new page', async () => {
  const client = { content: vi.fn(async (_scope: string, input: { itemId: string; part: string; offset: number }) => ({ ok: true,
    value: { itemId: input.itemId, part: input.part, offset: input.offset, text: 'Loaded content', nextOffset: input.offset ? null : 100, total: 200 } })), cancel: vi.fn() };
  TestBed.configureTestingModule({ providers: [{ provide: SessionChatClient, useValue: client }] });
  const fixture = TestBed.createComponent(SessionChatContentComponent);
  fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1, sessionId: 2 });
  fixture.componentRef.setInput('itemId', 'result');
  fixture.componentRef.setInput('source', { inputId: 'call', outputId: 'result' });
  fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  document.querySelector<HTMLElement>('pre[aria-label="Original tool output"]')!.scrollTop = 120;
  fixture.componentInstance.next(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  expect(document.querySelector<HTMLElement>('pre[aria-label="Original tool output"]')!.scrollTop).toBe(0);
  fixture.componentRef.setInput('unreachable', 'dev-box');
  fixture.componentInstance.switchPart('input'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  expect(document.body.textContent).toContain('Back to loaded page');
  const calls = client.content.mock.calls.length;
  fixture.componentInstance.returnToLoaded(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  expect(fixture.componentInstance.visiblePage()?.itemId).toBe('result');
  expect(client.content.mock.calls).toHaveLength(calls);
});
