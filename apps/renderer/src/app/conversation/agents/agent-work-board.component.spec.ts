import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkBoardComponent } from './agent-work-board.component';
import type { AgentWorkBoard, AgentWorkCard, AgentWorkIntent } from './agent-work.models';

const session = (sessionId: number) => ({ kind: 'session' as const, session: { sessionId, title: 'Agent ' + sessionId } });
const card = (id: number, status: AgentWorkCard['status']): AgentWorkCard =>
  ({ id: 'agent-' + id, title: 'Agent ' + id, status, detail: '', target: session(id) });

function setup(board: AgentWorkBoard) {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const fixture = TestBed.createComponent(AgentWorkBoardComponent);
  fixture.componentRef.setInput('board', board);
  fixture.detectChanges();
  return fixture;
}
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

describe('agent work board', () => {
  it('names live work and drops the verb once every agent has settled', () => {
    const live = setup({ agents: [card(1, 'running'), card(2, 'completed')] });
    expect(live.nativeElement.querySelector('.board-head strong').textContent).toMatch(/^Working with\s*2\s*agents/);
    const settled = setup({ agents: [card(1, 'completed'), card(2, 'completed')] });
    expect(settled.nativeElement.querySelector('.board-head strong').textContent).not.toContain('Working with');
  });

  it('labels the row action for a decision and a failure, and routes each to its own intent', () => {
    const fixture = setup({ agents: [card(1, 'waiting'), card(2, 'error'), card(3, 'running')] });
    const requested: AgentWorkIntent[] = [];
    fixture.componentInstance.requested.subscribe(intent => requested.push(intent));
    const root: HTMLElement = fixture.nativeElement;
    const action = (id: number) => root.querySelector<HTMLButtonElement>(`.quick-open[data-agent-session="${id}"]`)!;
    expect(action(1).getAttribute('aria-label')).toBe('Open to answer Agent 1');
    expect(action(1).querySelector('.quick-label')?.textContent).toBe('Open to answer');
    expect(action(2).getAttribute('aria-label')).toBe('Open to retry Agent 2');
    expect(action(3).querySelector('.quick-label')).toBeNull();
    action(1).click(); action(2).click(); action(3).click();
    expect(requested.map(intent => intent.action)).toEqual(['answer', 'message', 'open']);
  });
});
