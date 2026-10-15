import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ClaudeTurnChangesComponent } from './claude-turn-changes.component';

describe('ClaudeTurnChangesComponent capture status', () => {
  for (const theme of ['light', 'dark']) {
    it(`shows shared ownership, missing diffs and incomplete capture in ${theme} mode`, async () => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      try {
        await TestBed.configureTestingModule({ imports: [ClaudeTurnChangesComponent] }).compileComponents();
        const fixture = TestBed.createComponent(ClaudeTurnChangesComponent);
        fixture.componentRef.setInput('details', {
          files: 1, additions: 0, deletions: 0,
          capture: { root: '/repo', shared: true, complete: false, message: 'Some changes could not be captured.' },
          filesChanged: [{ path: 'binary.bin', status: 'modified', additions: 0, deletions: 0, hunks: [],
            attribution: 'shared', diffUnavailable: 'Binary file changed' }],
        });
        fixture.detectChanges();
        const element: HTMLElement = fixture.nativeElement;
        expect(element.querySelector('[role=status]')?.textContent).toContain('multiple agents were active');
        expect(element.textContent).toContain('Some changes could not be captured');
        expect(element.textContent).toContain('Line counts may be incomplete');
        const expand = element.querySelector<HTMLButtonElement>('[aria-expanded]')!;
        expect(expand.getAttribute('aria-expanded')).toBe('true');
        expand.click(); fixture.detectChanges();
        expect(expand.getAttribute('aria-expanded')).toBe('false');
        fixture.componentRef.setInput('details', { files: 0, additions: 0, deletions: 0, filesChanged: [],
          capture: { root: '/repo', complete: false, shared: false, message: 'Capture unavailable.' } });
        fixture.detectChanges();
        expect(element.textContent).toContain('Capture unavailable');
        fixture.destroy();
      } finally { document.documentElement.classList.remove('dark'); }
    });
  }
});
