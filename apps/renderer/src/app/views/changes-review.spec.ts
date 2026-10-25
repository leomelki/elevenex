import { TestBed } from '@angular/core/testing';
import { ChangeListComponent } from './change-list.component';
import { DiffFileComponent } from './diff-file.component';
import { DiffReviewComponent } from './diff-review.component';
import { ChangeFile, DiffFileContent } from './view.models';

describe('Changes review usability', () => {
  const files: readonly ChangeFile[] = [
    { id: 'first', path: 'src/first.ts', status: 'M', add: 1, del: 1 },
    { id: 'second', path: 'src/second.ts', status: 'A', add: 1, del: 0 },
  ];
  const content: DiffFileContent = {
    fileId: 'first', mode: 'changes', state: 'ready',
    hunks: [{ id: 'one', heading: '@@ -1 +1 @@', lines: [
      { id: 'plain', kind: 'del', oldNumber: 123456, text: '  old();  ' },
      { id: 'tokens', kind: 'add', newNumber: 123456, text: '  next();', spans: [{ text: '  ' }, { text: 'next', token: 'function' }, { text: '();' }] },
    ] }],
  };

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class {
      observe(): void { /* Visibility is driven explicitly in these tests. */ }
      disconnect(): void { /* No native observer in jsdom. */ }
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('preserves exact indentation and trailing whitespace for plain and tokenized code', () => {
    const fixture = TestBed.createComponent(DiffFileComponent);
    fixture.componentRef.setInput('file', files[0]);
    fixture.componentRef.setInput('content', content);
    fixture.detectChanges();
    const code = fixture.nativeElement.querySelectorAll('.code') as NodeListOf<HTMLElement>;
    expect(code[0]!.textContent).toBe('  old();  ');
    expect(code[1]!.textContent).toBe('  next();');
  });

  it('keeps file-list navigation separate from confirmation and handles each arrow once', () => {
    const fixture = TestBed.createComponent(ChangeListComponent);
    fixture.componentRef.setInput('items', files);
    fixture.componentRef.setInput('active', 'first');
    fixture.detectChanges();
    const selected = vi.fn(), activated = vi.fn(), bubbled = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    fixture.componentInstance.activated.subscribe(activated);
    const root: HTMLElement = fixture.nativeElement;
    root.addEventListener('keydown', bubbled);
    const list = root.querySelector('[role="listbox"]')!;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    expect(selected).toHaveBeenCalledExactlyOnceWith('second');
    expect(activated).not.toHaveBeenCalled();
    expect(bubbled).not.toHaveBeenCalled();
    fixture.componentRef.setInput('active', 'second');
    fixture.detectChanges();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(activated).toHaveBeenCalledExactlyOnceWith('second');
  });

  it('keeps the file picker open while browsing and closes it when confirmed', async () => {
    const fixture = TestBed.createComponent(DiffReviewComponent);
    fixture.componentRef.setInput('files', files);
    fixture.detectChanges();
    await fixture.whenStable();
    const selected = vi.fn();
    fixture.componentInstance.fileSelected.subscribe(selected);
    const trigger = fixture.nativeElement.querySelector('.jump') as HTMLButtonElement;
    trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    const list = document.querySelector('.file-menu [role="listbox"]')!;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    fixture.detectChanges(); await fixture.whenStable();
    expect(selected).toHaveBeenCalledExactlyOnceWith('second');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    fixture.detectChanges(); await fixture.whenStable();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fixture.destroy();
  });

  it('disables unavailable empty-review actions', () => {
    const fixture = TestBed.createComponent(DiffReviewComponent);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector<HTMLButtonElement>('.jump')?.disabled).toBe(true);
    expect([...root.querySelectorAll<HTMLButtonElement>('.modes button')].every(button => button.disabled)).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Wrap lines"]')?.disabled).toBe(true);
    expect(root.textContent).toContain('No changes to review');
  });

  it('does not leave an empty file list in the keyboard tab order', () => {
    const fixture = TestBed.createComponent(ChangeListComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="listbox"]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('No changed files');
  });

  it('does not submit a line question while confirming IME composition', () => {
    const fixture = TestBed.createComponent(DiffFileComponent);
    fixture.componentRef.setInput('file', files[0]);
    fixture.componentRef.setInput('content', content);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    root.querySelector<HTMLButtonElement>('.comment')!.click(); fixture.detectChanges();
    const input = root.querySelector('textarea')!;
    const commented = vi.fn();
    fixture.componentInstance.commented.subscribe(commented);
    input.value = 'Why change this?'; input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
    expect(commented).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    expect(commented).toHaveBeenCalledWith(expect.objectContaining({ line: 123456, side: 'old', text: 'Why change this?' }));
  });
});
