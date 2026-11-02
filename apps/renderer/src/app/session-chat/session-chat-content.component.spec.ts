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
