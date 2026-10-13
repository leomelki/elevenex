import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeTurnSummaryComponent } from './claude-turn-summary.component';

describe('ClaudeTurnSummaryComponent agents', () => {
  it('hides finished rows until expanded while keeping active agents and inspection visible', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeTurnSummaryComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClaudeTurnSummaryComponent);
    fixture.componentRef.setInput('durationLabel', '1m');
    fixture.componentRef.setInput('stepCount', 2);
    fixture.componentRef.setInput('canInspect', true);
    fixture.componentRef.setInput('agentSummary', {
      turnId: 'turn',
      agents: [
        {
          agentId: 'done',
          agentType: 'worker',
          displayName: 'Finished reviewer',
          status: 'stopped',
          executionStatus: 'completed',
        },
        {
          agentId: 'live',
          agentType: 'worker',
          displayName: 'Active reviewer',
          status: 'started',
          executionStatus: 'running',
        },
      ],
    });
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.textContent).toContain('1 finished');
    expect(element.textContent).not.toContain('Finished reviewer');
    expect(element.textContent).toContain('Active reviewer');
    const toggle = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('finished'),
    )!;
    toggle.click();
    fixture.detectChanges();
    expect(element.textContent).toContain('Finished reviewer');
    const inspect = vi.fn();
    fixture.componentInstance.inspectAgent.subscribe(inspect);
    element.querySelector<HTMLButtonElement>('[data-state="stopped"]')!.click();
    expect(inspect).toHaveBeenCalledExactlyOnceWith('done');
    toggle.click();
    fixture.componentRef.setInput('expanded', true);
    fixture.detectChanges();
    expect(element.textContent).toContain('Finished reviewer');
  });
});
