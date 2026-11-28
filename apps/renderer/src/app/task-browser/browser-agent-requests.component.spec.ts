import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserHumanRequest, TaskBrowserCommand } from '@elevenex/shared';
import { BrowserAgentRequestsComponent } from './browser-agent-requests.component';

const request: BrowserHumanRequest = {
  id: 'ticket',
  sessionId: 42,
  tabId: 'page',
  kind: 'element',
  message: 'Choose <button> without activating it',
  status: 'pending',
  expiresAt: 1000000,
};
afterEach(() => TestBed.resetTestingModule());
describe('Browser agent requests', () => {
  function setup(value = request) {
    const fixture = TestBed.createComponent(BrowserAgentRequestsComponent);
    fixture.componentRef.setInput('requests', [value]);
    fixture.detectChanges();
    const intents: TaskBrowserCommand[] = [];
    fixture.componentInstance.commandRequested.subscribe((intent) =>
      intents.push(intent),
    );
    const buttons = () =>
      [
        ...fixture.nativeElement.querySelectorAll('button'),
      ] as HTMLButtonElement[];
    return { fixture, intents, buttons };
  }
  it('requires selection before confirmation and renders the agent message as text', () => {
    const { fixture, intents, buttons } = setup();
    expect(fixture.nativeElement.textContent).toContain(request.message);
    expect(fixture.nativeElement.querySelector('.message button')).toBeNull();
    expect(
      buttons().find((button) => button.textContent?.includes('Confirm'))
        ?.disabled,
    ).toBe(true);
    buttons()
      .find((button) => button.textContent?.includes('Select element'))!
      .click();
    expect(intents).toEqual([
      { kind: 'agent-request-pick', requestId: request.id },
    ]);
  });
  it('confirms the exact ticket without introducing the currently selected session', () => {
    const { intents, buttons } = setup({
      ...request,
      selection: {
        selector: 'css=[data-elevenex-picked="id"]',
        frames: [],
        tag: 'input',
        documentId: 'doc',
        x: 5,
        y: 5,
        width: 100,
        height: 20,
      },
    });
    buttons()
      .find((button) => button.textContent?.includes('Confirm'))!
      .click();
    expect(intents).toEqual([
      { kind: 'agent-request-complete', requestId: request.id },
    ]);
  });
  it('blocks duplicate commands while busy and permits cancelling an action request', () => {
    const { fixture, intents, buttons } = setup({ ...request, kind: 'action' });
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    expect(buttons().every((button) => button.disabled)).toBe(true);
    fixture.componentInstance.command('agent-request-complete', request.id);
    expect(intents).toEqual([]);
    fixture.componentRef.setInput('busy', false);
    fixture.detectChanges();
    buttons()
      .find((button) => button.textContent?.includes('Cancel'))!
      .click();
    expect(intents).toEqual([
      { kind: 'agent-request-cancel', requestId: request.id },
    ]);
  });
});
