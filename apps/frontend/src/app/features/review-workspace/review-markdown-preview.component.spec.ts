import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import { FilesService } from '@/shared/services/files.service';
import { ReviewMarkdownPreviewComponent } from './review-markdown-preview.component';

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

const DOC = [
  '# Title',
  '',
  'An intro paragraph about the thing.',
  '',
  '## Section',
  '',
  '| A | B |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '![A diagram](./img/diagram.png)',
  '',
  'Another paragraph.',
].join('\n');

describe('ReviewMarkdownPreviewComponent', () => {
  let fixture: ComponentFixture<ReviewMarkdownPreviewComponent>;
  let component: ReviewMarkdownPreviewComponent;
  let emitted: Array<{ id: string; mentions: DiffSelectionMention[] }>;
  let readFile: ReturnType<typeof vi.fn>;
  /** Stands in for state the HTTP chain reads while the request subscribes. */
  let connected: ReturnType<typeof signal<boolean>>;

  beforeEach(async () => {
    emitted = [];
    connected = signal(true);
    readFile = vi.fn(() => {
      // The api-base interceptor reads connection state synchronously, inside
      // whatever reactive context started the request.
      connected();
      return of({ content: DOC, language: 'markdown' });
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(Date.now()), 0),
    );

    await TestBed.configureTestingModule({
      imports: [ReviewMarkdownPreviewComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: FilesService, useValue: { readFile } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ReviewMarkdownPreviewComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('worktreePath', '/tmp/repo');
    fixture.componentRef.setInput('path', 'docs/notes.md');
    fixture.componentRef.setInput('changeHash', 'hash-1');
    fixture.componentRef.setInput('selectionActions', [
      { id: 'new-thread', label: 'New discussion', icon: 'lucideSparkles' },
    ]);
    component.selectionAction.subscribe((event) => emitted.push(event));

    await settle();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    await flush();
  }

  function selectParagraph(text: string): void {
    const paragraph = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.mp-md p'),
    ).find((element) => element.textContent?.includes(text))!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  }

  it('renders the document', () => {
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'An intro paragraph about the thing.',
    );
  });

  it('renders the block constructs the document uses, not just its paragraphs', () => {
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.mp-md h1')?.textContent).toBe('Title');
    expect(root.querySelector('.mp-md h2')?.textContent).toBe('Section');
    expect(root.querySelector('.mp-md th')?.textContent).toBe('A');
    expect(root.querySelector('.mp-md td')?.textContent).toBe('1');
  });

  it('loads an embedded image relative to the document, not the worktree root', () => {
    // The doc is `docs/notes.md`, so `./img/diagram.png` is `docs/img/diagram.png`.
    const image = (fixture.nativeElement as HTMLElement).querySelector('.mp-md img');
    expect(image?.getAttribute('alt')).toBe('A diagram');
    expect(image?.getAttribute('src')).toContain(
      `/raw/${encodeURIComponent('docs/img/diagram.png')}`,
    );
  });

  it('offers the host’s actions on a selection and anchors them to the source lines', () => {
    selectParagraph('An intro paragraph');
    component.captureSelection();
    fixture.detectChanges();

    const action = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '.cr-selection-menu__button',
    );
    expect(action?.textContent?.trim()).toBe('New discussion');

    action!.click();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe('new-thread');
    const mention = emitted[0].mentions[0];
    expect(mention.filePath).toBe('docs/notes.md');
    expect(mention.changeHash).toBe('hash-1');
    expect(mention.selectedText).toBe('An intro paragraph about the thing.');
    expect(mention.newLineStart).toBe(3);
    expect(mention.newLineEnd).toBe(3);
    // The menu closes once the action is taken.
    expect(component.selectionMenu()).toBeNull();
  });

  it('shows nothing when the selection is collapsed', () => {
    document.getSelection()?.removeAllRanges();
    component.captureSelection();
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.cr-selection-menu'),
    ).toBeNull();
  });

  it('keeps the document when state read during its request changes', async () => {
    // A connection blip used to reload the file, which swapped the article for
    // a spinner and dropped the reader back to the top.
    const article = (fixture.nativeElement as HTMLElement).querySelector('.mp-doc');

    connected.set(false);
    await settle();
    connected.set(true);
    await settle();

    expect(readFile).toHaveBeenCalledTimes(1);
    expect((fixture.nativeElement as HTMLElement).querySelector('.mp-doc')).toBe(article);
  });

  it('does not write back the scroll offset it reported itself', async () => {
    // The host echoes `scrolled` into `restoreScrollTop`; applying that echo a
    // frame late fought the user's own scrolling and dragged selections.
    const setScrollTop = vi.spyOn(Element.prototype, 'scrollTop', 'set');

    fixture.componentRef.setInput('restoreScrollTop', 240);
    await settle();

    expect(setScrollTop).not.toHaveBeenCalled();
  });

  it('restores the tab’s offset when a document is opened', async () => {
    const setScrollTop = vi.spyOn(Element.prototype, 'scrollTop', 'set');

    fixture.componentRef.setInput('path', 'docs/other.md');
    fixture.componentRef.setInput('restoreScrollTop', 180);
    await settle();

    expect(setScrollTop).toHaveBeenCalledWith(180);
  });
});
