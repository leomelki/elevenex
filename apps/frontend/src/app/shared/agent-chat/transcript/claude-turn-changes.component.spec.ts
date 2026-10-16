import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ClaudeTurnChangesComponent } from './claude-turn-changes.component';

describe('ClaudeTurnChangesComponent capture status', () => {
  for (const theme of ['light', 'dark']) {
    it(`loads every line of a large diff in a scrollable panel in ${theme} mode`, async () => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      try {
        await TestBed.configureTestingModule({ imports: [ClaudeTurnChangesComponent] }).compileComponents();
        const fixture = TestBed.createComponent(ClaudeTurnChangesComponent);
        const patch = '@@ -0,0 +1,1001 @@\n' + Array.from({ length: 1001 }, (_, index) =>
          `+const line${index} = ${index};\n`,
        ).join('');
        const details = {
          files: 1, additions: 1001, deletions: 0,
          filesChanged: [{ path: 'large.ts', status: 'created', additions: 1001, deletions: 0,
            hunks: [{ id: 'large', toolName: 'Filesystem', label: 'Changes during this turn',
              oldString: '', newString: '', additions: 1001, deletions: 0, patch }] }],
        };
        fixture.componentRef.setInput('details', details);
        fixture.detectChanges();
        const element: HTMLElement = fixture.nativeElement;
        const load = Array.from(element.querySelectorAll('button')).find((button) =>
          button.textContent?.trim() === 'Load diff',
        )!;
        expect(load).toBeTruthy();
        expect(element.querySelector('.cw-inline-diff__body')).toBeNull();
        load.click();
        fixture.detectChanges();
        const body = element.querySelector('.cw-inline-diff__body')!;
        expect(body.textContent).toContain('const line1000 = 1000;');
        expect(body.classList.contains('max-h-112')).toBe(true);
        expect(body.classList.contains('overflow-auto')).toBe(true);
        const expand = element.querySelector<HTMLButtonElement>('[aria-expanded]')!;
        expand.click(); fixture.detectChanges();
        expand.click(); fixture.detectChanges();
        expect(element.querySelector('.cw-inline-diff__body')).toBeTruthy();
        // A new snapshot must not inherit approval to render another large diff.
        fixture.componentRef.setInput('details', { ...details,
          filesChanged: details.filesChanged.map((file) => ({ ...file })) });
        fixture.detectChanges();
        expect(element.querySelector('.cw-inline-diff__body')).toBeNull();
        expect(element.textContent).toContain('Load diff');
        fixture.destroy();
      } finally { document.documentElement.classList.remove('dark'); }
    });

    it(`renders a regular diff immediately in ${theme} mode`, async () => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      try {
        await TestBed.configureTestingModule({ imports: [ClaudeTurnChangesComponent] }).compileComponents();
        const fixture = TestBed.createComponent(ClaudeTurnChangesComponent);
        fixture.componentRef.setInput('details', {
          files: 1, additions: 1, deletions: 0,
          filesChanged: [{ path: 'small.ts', status: 'created', additions: 1, deletions: 0,
            hunks: [{ id: 'small', toolName: 'Filesystem', label: 'Changes during this turn',
              oldString: '', newString: '', additions: 1, deletions: 0,
              patch: '@@ -0,0 +1 @@\n+const value = 1;\n' }] }],
        });
        fixture.detectChanges();
        const element: HTMLElement = fixture.nativeElement;
        expect(element.querySelector('.cw-inline-diff__body')?.textContent).toContain('const value = 1;');
        expect(element.textContent).not.toContain('Load diff');
        fixture.destroy();
      } finally { document.documentElement.classList.remove('dark'); }
    });

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
