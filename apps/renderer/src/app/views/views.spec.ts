import { TestBed } from '@angular/core/testing';
import { BrowserViewComponent } from './browser-view.component';
import { DiffFileComponent } from './diff-file.component';
import { DiffReviewComponent } from './diff-review.component';
import { TerminalViewComponent } from './terminal-view.component';
import { ViewTabsComponent } from './view-tabs.component';
import { ChangeFile, DiffFileContent, TerminalBrowserFeedback } from './view.models';

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
    expect(input.value).toBe('Passed');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(trigger);
    expect(input.closest('.find')?.hasAttribute('inert')).toBe(true);
    expect(trigger.closest('ex-view-tabs')).not.toBeNull();
    expect(input.closest('ex-fold')?.hasAttribute('inert')).toBe(true);
  });

  it('navigates terminal matches by buttons and keyboard, and restores focus from Close', async () => {
    const fixture = TestBed.createComponent(TerminalViewComponent);
    fixture.componentRef.setInput('tabs', [{ id: 'one', title: 'Shell', status: 'idle' }]);
    fixture.detectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const trigger = root.querySelector<HTMLButtonElement>('[aria-label="Find in terminal (⌘F)"]')!;
    const previous = root.querySelector<HTMLButtonElement>('[aria-label="Previous match (Shift+Enter)"]')!;
    const next = root.querySelector<HTMLButtonElement>('[aria-label="Next match (Enter)"]')!;
    trigger.focus(); trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(trigger.closest('ex-view-tabs')).not.toBeNull();
    expect(root.querySelector('input')?.closest('.toolbar')).not.toBeNull();
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(true);
    const requested = vi.fn();
    fixture.componentInstance.searchRequested.subscribe(requested);
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'test'; input.dispatchEvent(new Event('input'));
    fixture.componentRef.setInput('findMatches', 3);
    fixture.componentRef.setInput('findStatus', '1 of 3'); fixture.detectChanges();
    previous.click(); expect(requested).toHaveBeenLastCalledWith({ query: 'test', backwards: true });
    next.click(); expect(requested).toHaveBeenLastCalledWith({ query: 'test', backwards: false });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(requested).toHaveBeenLastCalledWith({ query: 'test', backwards: true });
    requested.mockClear();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(requested).not.toHaveBeenCalled();
    fixture.componentRef.setInput('findMatches', 0);
    fixture.componentRef.setInput('findStatus', 'No results'); fixture.detectChanges();
    expect(previous.disabled).toBe(true); expect(next.disabled).toBe(true);
    expect(root.querySelector('.find-status')?.textContent).toBe('No results');
    const close = root.querySelector<HTMLButtonElement>('[aria-label="Close find (Escape)"]')!;
    close.focus(); close.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement).toBe(trigger);
    expect(input.closest('.find')?.hasAttribute('inert')).toBe(true);
    expect(requested).toHaveBeenLastCalledWith({ query: '', backwards: false });
    expect(root.querySelector('.find-status')?.textContent).toBe('');
  });

  for (const modifier of ['metaKey', 'ctrlKey']) it(`opens Find from terminal output with ${modifier} and returns focus on Escape`, async () => {
    const fixture = TestBed.createComponent(TerminalViewComponent);
    fixture.componentRef.setInput('tabs', [{ id: 'one', title: 'Shell', status: 'idle' }]);
    fixture.detectChanges(); await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const terminal = root.querySelector<HTMLElement>('.terminal')!;
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    const trigger = root.querySelector<HTMLButtonElement>('[aria-label="Find in terminal (⌘F)"]')!;
    expect(trigger.closest('ex-view-tabs')).not.toBeNull();
    expect(input.closest('ex-fold')?.hasAttribute('inert')).toBe(true);
    terminal.focus();
    terminal.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', [modifier]: true, bubbles: true }));
    fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement).toBe(input);
    expect(input.closest('ex-fold')?.hasAttribute('inert')).toBe(false);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement).toBe(terminal);
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
    (fixture.nativeElement.querySelector('.port-open') as HTMLButtonElement).click();
    expect(asked).toHaveBeenCalledWith({ tabId: 'tests', failure: { code: 1, cmd: 'pnpm test' } });
    expect(portOpened).not.toHaveBeenCalled();
  });

  it('preserves an unfinished address during page updates and navigates only on explicit Enter', () => {
    const fixture = TestBed.createComponent(BrowserViewComponent);
    fixture.componentRef.setInput('tabs', [{ id: 'one', title: 'Page', url: 'https://example.com/' }]);
    fixture.componentRef.setInput('addressEditable', true); fixture.detectChanges();
    const navigate = vi.fn(); fixture.componentInstance.navigated.subscribe(navigate);
    const input = fixture.nativeElement.querySelector('.address input') as HTMLInputElement;
    input.value = 'https://example.com/next'; input.dispatchEvent(new Event('input', { bubbles: true })); fixture.detectChanges();
    fixture.componentRef.setInput('tabs', [{ id: 'one', title: 'Page', url: 'https://example.com/background' }]); fixture.detectChanges();
    expect(input.value).toBe('https://example.com/next'); expect(navigate).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); fixture.detectChanges();
    expect(navigate).toHaveBeenCalledWith('https://example.com/next');
  });

  it('keeps browser handoff feedback and actions together for the selected server', async () => {
    const fixture = TestBed.createComponent(TerminalViewComponent);
    const server = { id: 'web', title: 'Web', status: 'serving' as const, port: 8080 };
    const shell = { id: 'shell', title: 'Shell', status: 'idle' as const };
    const update = (browser?: TerminalBrowserFeedback) => {
      fixture.componentRef.setInput('tabs', [{ ...server, browser }, shell]);
      fixture.detectChanges();
    };
    const opened = vi.fn(), stopped = vi.fn(), copied = vi.fn();
    fixture.componentInstance.portOpened.subscribe(opened);
    fixture.componentInstance.stopRequested.subscribe(stopped);
    fixture.componentInstance.portCopyRequested.subscribe(copied);
    update();
    const root = fixture.nativeElement as HTMLElement;
    const open = () => root.querySelector<HTMLButtonElement>('.port-open')!;
    const stop = () => root.querySelector<HTMLButtonElement>('.stop')!;
    const copy = () => root.querySelector<HTMLButtonElement>('.port-copy button')!;
    expect(open().textContent).toContain('http://127.0.0.1:8080/');
    copy().click(); expect(copied).toHaveBeenLastCalledWith(8080);
    expect(opened).not.toHaveBeenCalled();
    open().click(); expect(opened).toHaveBeenLastCalledWith(8080);
    update({ busy: true, error: '', url: '' });
    expect(open().disabled).toBe(true);
    expect(copy().disabled).toBe(true);
    expect(open().getAttribute('aria-busy')).toBe('true');
    open().click(); expect(opened).toHaveBeenCalledTimes(1);
    stop().click(); expect(stopped).toHaveBeenLastCalledWith('web');
    update({ busy: false, error: 'Could not open your browser.', url: '' });
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Could not open your browser.');
    expect(open().textContent).toContain('http://127.0.0.1:8080/');
    open().click(); expect(opened).toHaveBeenCalledTimes(2);
    update({ busy: false, error: '', url: 'http://127.0.0.1:24766/' });
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(open().textContent).toContain('http://127.0.0.1:24766/');
    expect(open().getAttribute('aria-label')).toBe('Open http://127.0.0.1:24766/ in your browser');
    update({ busy: false, copyBusy: true, error: '', url: 'http://127.0.0.1:24766/' });
    expect(copy().disabled).toBe(true); expect(open().disabled).toBe(true); expect(stop().disabled).toBe(false);
    update({ busy: false, copied: true, error: '', url: 'http://127.0.0.1:24766/' });
    expect(copy().getAttribute('aria-label')).toBe('URL copied');
    expect(root.querySelector('.port-status')?.textContent).toBe('URL copied');
    fixture.componentRef.setInput('disabled', true); fixture.detectChanges();
    expect(open().disabled).toBe(true); expect(copy().disabled).toBe(true); expect(stop().disabled).toBe(true);
    fixture.componentRef.setInput('disabled', false); fixture.detectChanges();
    const find = root.querySelector<HTMLButtonElement>('[aria-label="Find in terminal (⌘F)"]')!;
    find.focus(); find.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(root.querySelector<HTMLElement>('.server')?.hidden).toBe(true);
    expect(root.querySelector('.server')?.hasAttribute('inert')).toBe(true);
    root.querySelector<HTMLInputElement>('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges(); await fixture.whenStable();
    expect(root.querySelector<HTMLElement>('.server')?.hidden).toBe(false);
    expect(open().textContent).toContain('http://127.0.0.1:24766/');
    fixture.componentRef.setInput('active', 'shell'); fixture.detectChanges();
    expect(root.querySelector('.port-open')).toBeNull();
    expect(root.textContent).not.toContain('http://127.0.0.1:24766/');
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

  it('keeps a partly scrolled target in page viewport coordinates', () => {
    const fixture = TestBed.createComponent(BrowserViewComponent);
    fixture.componentRef.setInput('tabs', [{ id: 'one', title: 'Page' }]);
    fixture.componentRef.setInput('picked', { x: -10, y: -20, w: 100, h: 60, label: 'Partly visible element' });
    fixture.detectChanges();
    const ring = fixture.nativeElement.querySelector('.target') as HTMLElement;
    expect(ring.style.transform).toBe('translate(-14px, -24px)');
    expect(ring.style.width).toBe('108px'); expect(ring.style.height).toBe('68px');
  });

  it('clears page chrome and questions when the last browser tab closes', () => {
    const fixture = TestBed.createComponent(BrowserViewComponent);
    fixture.componentRef.setInput('tabs', [{ id: 'one', title: 'Checkout', url: 'localhost' }]);
    fixture.componentRef.setInput('driver', 'needs');
    fixture.componentRef.setInput('picked', { x: 10, y: 20, w: 100, h: 30, label: 'Pay' });
    fixture.componentRef.setInput('errors', 2);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector<HTMLDivElement>('.page')?.hidden).toBe(false);
    expect(root.querySelector('.question')).not.toBeNull();
    fixture.componentRef.setInput('tabs', []);
    fixture.detectChanges();
    expect(root.querySelector<HTMLDivElement>('.page')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.driver')?.hidden).toBe(true);
    expect(root.querySelector('.question, .driving-frame')).toBeNull();
    expect(root.querySelector('.needs')?.closest('ex-fold')?.hasAttribute('inert')).toBe(true);
    expect(root.querySelector('.errors')?.closest('ex-fold')?.hasAttribute('inert')).toBe(true);
    expect(root.querySelector('.empty')?.textContent).toContain('New tab');
  });

  it('dismisses a browser question and preserves IME confirmation before sending', () => {
    const fixture = TestBed.createComponent(BrowserViewComponent);
    fixture.componentRef.setInput('tabs', [{ id: 'one', title: 'Checkout', url: 'localhost' }]);
    fixture.componentRef.setInput('picked', { x: 10, y: 20, w: 100, h: 30, label: 'Pay' });
    fixture.detectChanges();
    const asked = vi.fn(), picking = vi.fn();
    fixture.componentInstance.asked.subscribe(asked);
    fixture.componentInstance.pickingChange.subscribe(picking);
    const root: HTMLElement = fixture.nativeElement;
    const input = root.querySelector('textarea')!;
    input.value = 'Change the label'; input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(asked).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'one', text: 'Change the label' }));
    root.querySelector<HTMLButtonElement>('[aria-label="Dismiss question (Esc)"]')!.click();
    expect(picking).toHaveBeenCalledWith(false);
  });

  it('shows bounded workflow progress and the active agent tab, then clears driving UI on takeover', () => {
    const fixture = TestBed.createComponent(BrowserViewComponent);
    fixture.componentRef.setInput('tabs', [{ id: 'checkout', title: 'Checkout', by: 'agent' }, { id: 'docs', title: 'Docs', by: 'agent' }]);
    fixture.componentRef.setInput('active', 'checkout');
    fixture.componentRef.setInput('driver', 'agent');
    fixture.componentRef.setInput('action', { x: 20, y: 80, w: 100, h: 30, label: 'Pay' });
    fixture.componentRef.setInput('step', { n: 50, total: 100, text: 'Checking payment' });
    fixture.componentRef.setInput('errors', 2);
    fixture.componentRef.setInput('agentWaiting', true);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelectorAll('.step-dots i')).toHaveLength(12);
    expect(root.querySelectorAll('.step-dots .now')).toHaveLength(1);
    expect(root.querySelectorAll('[aria-label="The agent is using this tab"]')).toHaveLength(1);
    expect(root.querySelector('[data-tab-id="checkout"] .driving')).not.toBeNull();
    expect(root.querySelector('.agent-cursor')).not.toBeNull();
    expect(root.querySelector('.driving-frame')).not.toBeNull();
    const workflow = root.querySelector('.agent-step');
    const sendErrors = vi.fn(); fixture.componentInstance.sendErrorsRequested.subscribe(sendErrors);
    root.querySelector<HTMLButtonElement>('[aria-label="Send 2 error counts to agent"]')!.click();
    expect(sendErrors).toHaveBeenCalledOnce();
    expect(root.querySelector('.errors')?.closest('ex-fold')?.hasAttribute('inert')).toBe(true);
    fixture.componentRef.setInput('driver', 'you');
    fixture.detectChanges();
    expect(root.querySelector('.agent-cursor, .driving-frame, .agent.driving')).toBeNull();
    expect(root.querySelector('.errors')?.closest('ex-fold')?.hasAttribute('inert')).toBe(true);
    expect(root.textContent).toContain('You’re driving; the agent waits');
    expect(root.querySelector('.agent-step')).toBe(workflow);
    fixture.componentRef.setInput('step', { n: 1, total: Infinity, text: 'Invalid total' });
    fixture.detectChanges();
    expect(root.querySelectorAll('.step-dots i')).toHaveLength(0);
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
