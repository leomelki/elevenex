import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AgentCollaborationComponent } from './agent-collaboration.component';
import { buildSubagentIndex } from '@/shared/agent-tools/agent-collaboration-format';

const timestamp = '2026-10-12T10:00:00.000Z';
async function render(known = true) {
  await TestBed.configureTestingModule({
    imports: [AgentCollaborationComponent],
  }).compileComponents();
  const fixture = TestBed.createComponent(AgentCollaborationComponent);
  fixture.componentRef.setInput('call', {
    id: 'call',
    kind: 'tool_use',
    toolName: 'send_message',
    toolInput: { target: '/root/reviewer', message: 'Inspect **caching** and reconnects.' },
    timestamp,
  });
  fixture.componentRef.setInput('result', {
    id: 'result',
    kind: 'tool_result',
    content: '{"queued":true}',
    timestamp,
  });
  fixture.componentRef.setInput('canInspect', true);
  fixture.componentRef.setInput(
    'agents',
    buildSubagentIndex(
      known
        ? [
            {
              agentId: 'child',
              agentPath: '/root/reviewer',
              agentType: 'explorer',
              displayName: 'Ada',
              status: 'started',
              executionStatus: 'running',
              timestamp,
            },
          ]
        : [],
    ),
  );
  fixture.detectChanges();
  return fixture;
}
describe('AgentCollaborationComponent', () => {
  it.each(['light', 'dark'])(
    'shows a readable receipt with a real inspector link in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      try {
        const fixture = await render();
        expect(fixture.nativeElement.textContent).toContain('Message sent');
        expect(fixture.nativeElement.textContent).toContain('Running');
        const inspect = vi.fn();
        fixture.componentInstance.inspectAgent.subscribe(inspect);
        (
          fixture.nativeElement.querySelector('[aria-label="Inspect Ada"]') as HTMLButtonElement
        ).click();
        expect(inspect).toHaveBeenCalledExactlyOnceWith('child');
        expect(fixture.componentInstance.expanded()).toBe(false);
        fixture.nativeElement.querySelector('[aria-expanded]').click();
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('agent-markdown strong').textContent).toBe(
          'caching',
        );
        expect(fixture.nativeElement.querySelector('pre')).toBeNull();
      } finally {
        document.documentElement.classList.remove('dark');
      }
    },
  );
  it('does not offer a dead inspector link for an unknown recipient', async () => {
    const fixture = await render(false);
    expect(fixture.nativeElement.querySelector('[aria-label^="Inspect"]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Reviewer');
  });
  it('collapses a finished agent and keeps its inspector available after expansion', async () => {
    const fixture = await render();
    fixture.componentRef.setInput(
      'agents',
      buildSubagentIndex([
        {
          agentId: 'child',
          agentPath: '/root/reviewer',
          agentType: 'explorer',
          displayName: 'Ada',
          status: 'stopped',
          executionStatus: 'completed',
          timestamp,
        },
      ]),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('article').getAttribute('data-compact')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('[aria-label="Inspect Ada"]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('1 agent');
    fixture.nativeElement.querySelector('[aria-expanded]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[aria-label="Inspect Ada"]')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Completed');
  });
  it('collapses an old running status when the agent has since stopped', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('call', {
      id: 'call',
      kind: 'tool_use',
      toolName: 'list_agents',
      toolInput: {},
      timestamp,
    });
    fixture.componentRef.setInput('result', {
      id: 'result',
      kind: 'tool_result',
      content: JSON.stringify({
        agents: [
          { agent_id: 'child', status: 'running' },
          { agent_name: '/root', agent_status: 'running' },
        ],
      }),
      timestamp,
    });
    fixture.componentRef.setInput(
      'agents',
      buildSubagentIndex([
        {
          agentId: 'child',
          agentType: 'explorer',
          displayName: 'Ada',
          status: 'stopped',
          executionStatus: 'interrupted',
          timestamp: '2026-10-12T11:00:00.000Z',
        },
      ]),
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleRows()).toEqual([]);
    expect(fixture.nativeElement.querySelector('cw-subagent-status')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('active');
    fixture.nativeElement.querySelector('[aria-expanded]').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Statuses reported by this step');
    expect(fixture.nativeElement.textContent).toContain('Now');
    expect(fixture.nativeElement.textContent).toContain('Stopped');
  });
  it('keeps a failed agent visible for attention', async () => {
    const fixture = await render();
    fixture.componentRef.setInput(
      'agents',
      buildSubagentIndex([
        {
          agentId: 'child',
          agentPath: '/root/reviewer',
          agentType: 'explorer',
          displayName: 'Ada',
          status: 'stopped',
          executionStatus: 'error',
          timestamp,
        },
      ]),
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.compact()).toBe(false);
    expect(fixture.nativeElement.querySelector('[aria-label="Inspect Ada"]')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Failed');
  });
  it('copies the readable message rather than its JSON envelope', async () => {
    const fixture = await render();
    const old = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      fixture.componentInstance.expanded.set(true);
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[aria-label="Copy message"]').click();
      await fixture.whenStable();
      expect(writeText).toHaveBeenCalledExactlyOnceWith('Inspect **caching** and reconnects.');
    } finally {
      if (old) Object.defineProperty(navigator, 'clipboard', old);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
