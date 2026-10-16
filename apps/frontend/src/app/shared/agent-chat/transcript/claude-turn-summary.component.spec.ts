import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeTurnSummaryComponent } from './claude-turn-summary.component';

describe('ClaudeTurnSummaryComponent changes', () => {
  it.each(['light', 'dark'])(
    'hides empty changes in %s mode, including capture metadata',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      try {
        await TestBed.configureTestingModule({
          imports: [ClaudeTurnSummaryComponent],
        }).compileComponents();
        const fixture = TestBed.createComponent(ClaudeTurnSummaryComponent);
        fixture.componentRef.setInput('durationLabel', '1s');
        fixture.componentRef.setInput('stepCount', 2);

        for (const capture of [
          undefined,
          { root: '/repo', complete: true, shared: false },
          { root: '/repo', complete: false, shared: true, message: 'Capture unavailable' },
        ]) {
          fixture.componentRef.setInput('changeDetails', {
            files: 0,
            additions: 0,
            deletions: 0,
            filesChanged: [],
            capture,
          });
          fixture.detectChanges();
          expect(fixture.nativeElement.querySelector('.cw-turn-gap__changes-button')).toBeNull();
          expect(fixture.nativeElement.textContent).toContain('Worked for 1s');
        }

        // Binary and metadata-only changes still have files worth inspecting.
        fixture.componentRef.setInput('changeDetails', {
          files: 1,
          additions: 0,
          deletions: 0,
          filesChanged: [
            { path: 'image.png', status: 'modified', additions: 0, deletions: 0, hunks: [] },
          ],
        });
        fixture.detectChanges();
        const button = fixture.nativeElement.querySelector('.cw-turn-gap__changes-button');
        expect(button?.textContent).toContain('View changes');
        expect(button?.textContent).toContain('1 file');
        const toggleChanges = vi.fn();
        fixture.componentInstance.toggleChanges.subscribe(toggleChanges);
        button.click();
        expect(toggleChanges).toHaveBeenCalledOnce();

        fixture.componentRef.setInput('changeDetails', {
          files: 0,
          additions: 0,
          deletions: 0,
          filesChanged: [],
        });
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.cw-turn-gap__changes-button')).toBeNull();
        fixture.destroy();
      } finally {
        document.documentElement.classList.remove('dark');
      }
    },
  );
});

describe('ClaudeTurnSummaryComponent agents', () => {
  it('shows port-forwarding attention even while activity is collapsed', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeTurnSummaryComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClaudeTurnSummaryComponent);
    fixture.componentRef.setInput('durationLabel', '1s');
    fixture.componentRef.setInput('stepCount', 2);
    fixture.componentRef.setInput('portForwardingAttention', 1);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-port-forwarding-attention]')?.textContent,
    ).toContain('reported an issue');
    expect(fixture.nativeElement.querySelector('button')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    fixture.destroy();
  });
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
