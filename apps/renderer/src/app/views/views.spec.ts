import { TestBed } from '@angular/core/testing';
import { BrowserViewComponent } from './browser-view.component';
import { DiffFileComponent } from './diff-file.component';
import { DiffReviewComponent } from './diff-review.component';
import { TerminalViewComponent } from './terminal-view.component';
import { ViewTabsComponent } from './view-tabs.component';
import { ChangeFile, DiffFileContent } from './view.models';

describe('Side-view interactions', () => {
  it('moves tab focus by keyboard and emits stable identities for closing', () => {
    const fixture = TestBed.createComponent(ViewTabsComponent);
    fixture.componentRef.setInput('items', [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }]);
    fixture.detectChanges();
    const selected = vi.fn();
    const closed = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    fixture.componentInstance.closed.subscribe(closed);
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]') as NodeListOf<HTMLButtonElement>;
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(selected).toHaveBeenCalledWith('two');
    expect(document.activeElement).toBe(tabs[1]);
    tabs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(closed).toHaveBeenCalledWith('two');
  });

  it('keeps keyboard focus on a surviving tab after closing, then on New tab when empty', async () => {
    const fixture = TestBed.createComponent(ViewTabsComponent);
    fixture.componentRef.setInput('items', [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }]);
    fixture.componentRef.setInput('active', 'two');
    fixture.detectChanges();
    await fixture.whenStable();
    const closing = fixture.nativeElement.querySelector('[data-tab-id="two"]') as HTMLButtonElement;
    closing.focus();
    closing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    fixture.componentRef.setInput('items', [{ id: 'one', title: 'One' }]);
    fixture.detectChanges();
    await fixture.whenStable();
    const remaining = fixture.nativeElement.querySelector('[data-tab-id="one"]') as HTMLButtonElement;
    expect(document.activeElement).toBe(remaining);
    expect(remaining.getAttribute('aria-selected')).toBe('true');
    expect(remaining.tabIndex).toBe(0);
    remaining.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    fixture.componentRef.setInput('items', []);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('[aria-label="New tab"]'));
  });

  it('focuses terminal Find and clears hidden filtering when it closes', async () => {
    const fixture = TestBed.createComponent(TerminalViewComponent);
    fixture.componentRef.setInput('tabs', [{ id: 'one', title: 'Shell', status: 'idle' }]);
    fixture.componentRef.setInput('output', [{ id: 'one', kind: 'cmd', text: 'pnpm test' }, { id: 'two', kind: 'ok', text: 'Passed' }]);
    fixture.detectChanges();
    await fixture.whenStable();
    const trigger = fixture.nativeElement.querySelector('[aria-label="Find in terminal (⌘F)"]') as HTMLButtonElement;
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const input = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    input.value = 'Passed';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(trigger);
    expect(input.closest('ex-fold')?.hasAttribute('inert')).toBe(true);
  });

  it('reports a failed user command with its tab and refuses invalid ports', () => {
    const fixture = TestBed.createComponent(TerminalViewComponent);
    fixture.componentRef.setInput('tabs', [{ id: 'tests', title: 'Tests', status: 'serving', port: 90000 }]);
    fixture.componentRef.setInput('failure', { code: 1, cmd: 'pnpm test' });
    fixture.detectChanges();
    const asked = vi.fn();
    const portOpened = vi.fn();
    fixture.componentInstance.askRequested.subscribe(asked);
    fixture.componentInstance.portOpened.subscribe(portOpened);
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>);
    buttons.find(button => button.textContent?.includes('Ask the agent'))!.click();
    buttons.find(button => button.textContent?.includes('Open :'))!.click();
    expect(asked).toHaveBeenCalledWith({ tabId: 'tests', failure: { code: 1, cmd: 'pnpm test' } });
    expect(portOpened).not.toHaveBeenCalled();
  });

  it('requests immediate takeover for page input only while the agent drives', () => {
    const fixture = TestBed.createComponent(BrowserViewComponent);
    fixture.componentRef.setInput('driver', 'agent');
    fixture.detectChanges();
    const takeover = vi.fn();
    fixture.componentInstance.takeOverRequested.subscribe(takeover);
    const preview = fixture.nativeElement.querySelector('.preview') as HTMLElement;
    preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(takeover).toHaveBeenCalledTimes(1);
    fixture.componentRef.setInput('driver', 'you');
    fixture.detectChanges();
    preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(takeover).toHaveBeenCalledTimes(1);
  });
});

describe('Diff review boundaries', () => {
  const file: ChangeFile = { id: 'stable-file', path: 'src/retry.ts', rev: 2, status: 'M', add: 1, del: 1 };
  const content: DiffFileContent = { fileId: file.id, rev: 2, mode: 'changes', state: 'ready', hunks: [{ id: 'hunk', heading: '@@ −1 +1 @@', before: 30, lines: [{ id: 'old', kind: 'del', oldNumber: 1, text: 'old()' }, { id: 'new', kind: 'add', newNumber: 1, text: 'new()' }] }] };

  it('selects cached content by file, current revision and mode without losing the other mode', async () => {
    vi.stubGlobal('IntersectionObserver', class {
      observe(): void { /* The test navigates explicitly instead of simulating visibility. */ }
      unobserve(): void { /* No native observer in jsdom. */ }
      disconnect(): void { /* No native observer in jsdom. */ }
    });
    const fixture = TestBed.createComponent(DiffReviewComponent);
    try {
      fixture.componentRef.setInput('files', [file]);
      fixture.componentRef.setInput('contents', [
        content,
        { ...content, mode: 'full', hunks: [{ id: 'full', heading: 'Full file', lines: [{ id: 'full-line', kind: 'context', newNumber: 1, text: 'full-file-context()' }] }] },
        { ...content, rev: 1, hunks: [{ id: 'stale', heading: 'Stale revision', lines: [{ id: 'stale-line', kind: 'add', newNumber: 1, text: 'stale-version()' }] }] },
      ]);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(fixture.nativeElement.textContent).toContain('new()');
      expect(fixture.nativeElement.textContent).not.toContain('full-file-context()');
      expect(fixture.nativeElement.textContent).not.toContain('stale-version()');
      expect(fixture.nativeElement.querySelector('[aria-label="Loading file"]')).toBeNull();

      fixture.componentRef.setInput('mode', 'full');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(fixture.nativeElement.textContent).toContain('full-file-context()');
      expect(fixture.nativeElement.textContent).not.toContain('new()');

      fixture.componentRef.setInput('mode', 'changes');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(fixture.nativeElement.textContent).toContain('new()');

      const requested = vi.fn();
      fixture.componentInstance.fileRequested.subscribe(requested);
      fixture.componentRef.setInput('files', [{ ...file, rev: 3 }]);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(fixture.nativeElement.textContent).not.toContain('new()');
      expect(fixture.nativeElement.querySelector('[aria-label="Loading file"]')).not.toBeNull();
      fixture.componentInstance.goTo(file.id);
      fixture.componentInstance.goTo(file.id);
      expect(requested).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ fileId: file.id, rev: 3, mode: 'changes' }));
    } finally {
      fixture.destroy();
      vi.unstubAllGlobals();
    }
  });

  it('ignores stale revisions and sends a retry request with the current revision', () => {
    const fixture = TestBed.createComponent(DiffFileComponent);
    fixture.componentRef.setInput('file', file);
    fixture.componentRef.setInput('content', { ...content, rev: 1 });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('old()');
    fixture.componentRef.setInput('content', { ...content, state: 'error', error: 'Read failed' });
    fixture.detectChanges();
    const requested = vi.fn();
    fixture.componentInstance.fileRequested.subscribe(requested);
    (Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[]).find(button => button.textContent?.includes('Try again'))!.click();
    expect(requested).toHaveBeenCalledWith({ fileId: file.id, rev: 2, mode: 'changes', reason: 'retry' });
  });

  it('does not show another file’s payload even if mode and revision match', () => {
    const fixture = TestBed.createComponent(DiffFileComponent);
    fixture.componentRef.setInput('file', file);
    fixture.componentRef.setInput('content', { ...content, fileId: 'another-file' });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('old()');
    expect(fixture.nativeElement.querySelector('[aria-label="Loading file"]')).not.toBeNull();
  });

  it('requests bounded context and sends comments with the old side of a deletion', () => {
    const fixture = TestBed.createComponent(DiffFileComponent);
    fixture.componentRef.setInput('file', file);
    fixture.componentRef.setInput('content', content);
    fixture.detectChanges();
    const context = vi.fn();
    const commented = vi.fn();
    fixture.componentInstance.contextRequested.subscribe(context);
    fixture.componentInstance.commented.subscribe(commented);
    (fixture.nativeElement.querySelector('[aria-label="Show 20 lines above"]') as HTMLButtonElement).click();
    expect(context).toHaveBeenCalledWith({ fileId: file.id, rev: 2, mode: 'changes', hunkId: 'hunk', direction: 'before', count: 20 });
    (fixture.nativeElement.querySelector('[data-kind="del"] .comment') as HTMLButtonElement).click();
    fixture.detectChanges();
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = ' Why remove this? ';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    expect(commented).toHaveBeenCalledWith({ fileId: file.id, path: file.path, rev: 2, line: 1, side: 'old', text: 'Why remove this?' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.note')?.textContent).toContain('Why remove this?');
  });

  it('reopens a file edited since viewing and bounds the rendered lines', () => {
    const fixture = TestBed.createComponent(DiffFileComponent);
    fixture.componentRef.setInput('file', { ...file, viewed: true, changedSinceViewed: true });
    fixture.componentRef.setInput('content', { ...content, hunks: [{ id: 'large', heading: 'Large file', lines: Array.from({ length: 1000 }, (_, index) => ({ id: String(index), kind: 'context', newNumber: index + 1, text: `line ${index + 1}` })) }] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fold')?.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.querySelectorAll('.line').length).toBe(400);
    expect(fixture.nativeElement.textContent).toContain('Changed since viewed');
    expect(fixture.nativeElement.textContent).toContain('Page 1 of 3');
  });
});
