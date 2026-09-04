import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import { FilesService } from '@/shared/services/files.service';
import { ReviewMarkdownPreviewComponent } from './review-markdown-preview.component';

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

const DOC = ['# Title', '', 'An intro paragraph about the thing.', '', 'Another paragraph.'].join(
  '\n',
);

describe('ReviewMarkdownPreviewComponent', () => {
  let fixture: ComponentFixture<ReviewMarkdownPreviewComponent>;
  let component: ReviewMarkdownPreviewComponent;
  let emitted: Array<{ id: string; mentions: DiffSelectionMention[] }>;

  beforeEach(async () => {
    emitted = [];

    await TestBed.configureTestingModule({
      imports: [ReviewMarkdownPreviewComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: FilesService,
          useValue: { readFile: vi.fn(() => of({ content: DOC, language: 'markdown' })) },
        },
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

    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  });

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
});
