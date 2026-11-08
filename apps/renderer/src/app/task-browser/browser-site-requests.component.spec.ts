import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it } from 'vitest';
import { BrowserSiteRequestsComponent } from './browser-site-requests.component';
afterEach(() => TestBed.resetTestingModule());
it('keeps prompt drafts private until explicit confirmation and binds responses to their originating tab', () => {
  const fixture = TestBed.createComponent(BrowserSiteRequestsComponent);
  const component = fixture.componentInstance;
  const request = { id: 'request', kind: 'dialog' as const, type: 'prompt' as const, message: '<b>Site text</b>', defaultValue: 'default' };
  fixture.componentRef.setInput('tabId', 'first'); fixture.componentRef.setInput('requests', [request]); fixture.detectChanges();
  const sent: unknown[] = []; component.commandRequested.subscribe(value => sent.push(value));
  component.review(request); fixture.detectChanges();
  expect(component.draft()).toBe('default'); expect(sent).toEqual([]);
  expect(document.querySelector('.site-message')?.textContent).toBe('<b>Site text</b>'); expect(document.querySelector('.site-message b')).toBeNull();
  component.draft.set('human text'); component.answer(true);
  expect(sent).toEqual([{ kind: 'dialog-response', tabId: 'first', requestId: 'request', accept: true, text: 'human text' }]);
});
it('closes a retained dialog on tab change and cannot send its draft to the replacement tab', () => {
  const fixture = TestBed.createComponent(BrowserSiteRequestsComponent), component = fixture.componentInstance;
  const request = { id: 'request', kind: 'dialog' as const, type: 'confirm' as const, message: 'Continue?', defaultValue: '' };
  fixture.componentRef.setInput('tabId', 'first'); fixture.componentRef.setInput('requests', [request]); fixture.detectChanges(); component.review(request); fixture.detectChanges();
  const sent: unknown[] = []; component.commandRequested.subscribe(value => sent.push(value));
  fixture.componentRef.setInput('tabId', 'second'); fixture.detectChanges(); component.answer(true);
  expect(component.open()).toBe(false); expect(sent).toEqual([]);
});
