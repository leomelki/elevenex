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
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('agent work board', () => {
  it('names live work and drops the verb once every agent has settled', () => {
    const fixture = setup({ agents: [card(1, 'running'), card(2, 'completed')] });
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('.board-head strong')?.textContent).toMatch(/^Working with\s*2\s*agents/);
    fixture.componentRef.setInput('board', { agents: [card(1, 'completed'), card(2, 'completed')] });
    fixture.detectChanges();
    expect(root.querySelector('.board-head strong')?.textContent).toMatch(/^2\s*agents/);
  });

  it('keeps activity and one open control in place when a second agent joins', () => {
    const agent: AgentWorkCard = {
      ...card(1, 'running'), selection: { provider: 'codex', model: 'GPT-6', effort: 'high' }, ownSession: true,
      detail: 'Reading retry-claims.ts', usage: '18.5k tokens · 17 tools',
      messages: [{ id: 'message', text: 'Check delayed responses too.', status: 'Queued' }],
    };
    const fixture = setup({ agents: [agent] });
    const root: HTMLElement = fixture.nativeElement;
    const row = root.querySelector('[data-agent-source="1"]')!;
    const primary = row.querySelector('.primary-action');
    const activity = row.querySelector('.activity');
    expect(row.querySelector('[aria-expanded], button[aria-label^="Message"]')).toBeNull();
    expect(row.textContent).not.toContain('Own session');
    expect(row.textContent).not.toContain('18.5k tokens');
    expect(row.textContent).not.toContain('Check delayed responses too.');
    expect(row.querySelector('.model')?.textContent).toBe('GPT-6 · High');
    expect(activity?.textContent).toContain('Reading retry-claims.ts');

    fixture.componentRef.setInput('board', { agents: [agent, { ...card(2, 'running'), detail: 'Running…' }] });
    fixture.detectChanges();
    expect(row.querySelector('.activity')).toBe(activity);
    expect(root.querySelectorAll('[data-agent-session="1"]')).toHaveLength(1);
    expect(root.querySelector('[data-agent-session="1"]')).toBe(primary);
    expect(root.querySelector('[data-agent-source="2"] .activity')).toBeNull();
  });

  it('routes decision, retry, open, stop and native inspection to their existing intents', () => {
    const native = { kind: 'native' as const, agentId: 'native-agent' };
    const fixture = setup({ agents: [
      card(1, 'waiting'), card(2, 'error'), { ...card(3, 'running'), stoppable: true },
      { ...card(4, 'completed'), target: native }, { ...card(5, 'unavailable'), target: undefined },
    ] });
    const requested: AgentWorkIntent[] = [];
    fixture.componentInstance.requested.subscribe(intent => requested.push(intent));
    const root: HTMLElement = fixture.nativeElement;
    const action = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!;
    const answer = action('[data-agent-session="1"]');
    const retry = action('[data-agent-session="2"]');
    const open = action('[data-agent-session="3"]');
    const inspect = action('[data-state="completed"] .primary-action');
    expect(answer.getAttribute('aria-label')).toBe('Open to answer for Agent 1');
    expect(retry.textContent).toContain('Open to retry');
    expect(open.textContent?.trim()).toBe('Open');
    expect(open.getAttribute('aria-label')).toBe('Open session for Agent 3');
    expect(root.querySelector('[data-state="running"] .status-label .visually-hidden')?.textContent).toBe('Running');
    expect(root.querySelector('[data-state="completed"] .status-label .visually-hidden')?.textContent).toBe('Done');
    expect(root.querySelector('[data-state="waiting"] .status-label .visually-hidden')).toBeNull();
    expect(root.querySelector('[data-state="error"] .status-label .visually-hidden')).toBeNull();
    expect(inspect.textContent).toContain('Inspect');
    expect(root.querySelector('[data-state="unavailable"] button')).toBeNull();

    answer.click();
    retry.click();
    open.click();
    action('[data-agent-source="3"] .stop').click();
    inspect.click();
    expect(requested.map(intent => intent.action)).toEqual(['answer', 'message', 'open', 'stop', 'open']);
    expect(requested[0]?.origin).toBe(answer.closest('.agent'));
    expect(requested[4]?.target).toEqual(native);

    fixture.componentRef.setInput('controlsDisabled', true);
    fixture.detectChanges();
    expect(open.getAttribute('aria-disabled')).toBe('true');
    open.click();
    inspect.click();
    expect(requested.slice(5).map(intent => intent.target)).toEqual([native]);
  });

  it('ticks live elapsed time and keeps the final duration on completion', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const agent = { ...card(1, 'running'), startedAt: Date.now() - 4000 };
    const fixture = setup({ agents: [agent] });
    const root: HTMLElement = fixture.nativeElement;
    const time = () => root.querySelector('time')?.textContent?.trim();
    expect(time()).toBe('4s');
    vi.advanceTimersByTime(1000);
    fixture.detectChanges();
    expect(time()).toBe('5s');
    fixture.componentRef.setInput('board', { agents: [{ ...agent, status: 'completed', endedAt: Date.now() }] });
    fixture.detectChanges();
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
    expect(time()).toBe('5s');
  });
});
