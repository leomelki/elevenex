import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { SubagentOverviewComponent } from './subagent-overview.component';
import type { AgentSubagentState } from '@/shared/models/agent-runtime.model';

const finished: AgentSubagentState = {
  agentId: 'finished',
  agentType: 'worker',
  displayName: 'Done reviewer',
  status: 'stopped',
  executionStatus: 'completed',
  timestamp: '2026-10-12T10:00:00.000Z',
};
const active: AgentSubagentState = {
  ...finished,
  agentId: 'active',
  displayName: 'Active reviewer',
  status: 'started',
  executionStatus: 'running',
};

describe('SubagentOverviewComponent', () => {
  it.each(['light', 'dark'])(
    'keeps finished agents behind the summary in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      try {
        await TestBed.configureTestingModule({
          imports: [SubagentOverviewComponent],
        }).compileComponents();
        const fixture = TestBed.createComponent(SubagentOverviewComponent);
        fixture.componentRef.setInput('agents', [finished]);
        fixture.detectChanges();
        const element: HTMLElement = fixture.nativeElement;
        expect(element.textContent).toContain('1 finished');
        expect(element.querySelector('cw-subagent-status')).toBeNull();
        expect(element.querySelector('section')?.classList.contains('border')).toBe(false);
        const inspect = vi.fn();
        fixture.componentInstance.inspect.subscribe(inspect);
        element.querySelector('button')!.click();
        expect(inspect).toHaveBeenLastCalledWith('finished');
        fixture.componentRef.setInput('agents', [finished, active]);
        fixture.detectChanges();
        expect(element.textContent).toContain('1 active');
        expect(element.textContent).toContain('Active reviewer');
        expect(element.textContent).not.toContain('Done reviewer');
        expect(element.querySelectorAll('cw-subagent-status')).toHaveLength(1);
        element.querySelector('button')!.click();
        expect(inspect).toHaveBeenLastCalledWith('active');
      } finally {
        document.documentElement.classList.remove('dark');
      }
    },
  );
});
