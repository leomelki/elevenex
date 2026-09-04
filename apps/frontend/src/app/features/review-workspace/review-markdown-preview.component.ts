import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideRefreshCw, lucideTriangleAlert } from '@ng-icons/lucide';
import type {
  DiffSelectionMention,
  DiffSelectionMentionScope,
} from '@/shared/models/diff-selection-mention.model';
import { FilesService } from '@/shared/services/files.service';
import { MarkdownPipe } from '@/features/session/claude-workspace/pipes/markdown.pipe';
import {
  DEFAULT_DIFF_SELECTION_ACTIONS,
  DiffSelectionMenuComponent,
  type DiffSelectionMenuAction,
} from '@/features/change-review/diff-selection-menu.component';
import { buildMarkdownSelectionMention } from './review-markdown-selection';

/** Placement of the floating action bar, relative to the scrolled document. */
interface SelectionMenuState {
  top: number;
  left: number;
  mentions: DiffSelectionMention[];
}

/** Vertical gap between the selection and the action bar sitting above it. */
const MENU_OFFSET_PX = 38;

/**
 * Rendered view of a markdown file in the worktree.
 *
 * Reads the file rather than reassembling it from diff rows: rows are windowed,
 * so a long document would render only the parts that happen to be loaded.
 * That means this always shows the file as it is on disk now, which is what
 * you want when reading a doc — the diff tab remains the place to see changes.
 *
 * Selections offer the same actions as the diff, so a paragraph you are reading
 * can start a discussion without switching back to the diff to find its lines.
 */
@Component({
  selector: 'app-review-markdown-preview',
  standalone: true,
  imports: [CommonModule, NgIcon, MarkdownPipe, DiffSelectionMenuComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideRefreshCw, lucideTriangleAlert })],
  templateUrl: './review-markdown-preview.component.html',
  styleUrl: './review-markdown-preview.component.scss',
})
export class ReviewMarkdownPreviewComponent {
  readonly worktreePath = input.required<string>();
  readonly path = input.required<string>();
  /** Scroll offset to restore when this tab is re-focused. */
  readonly restoreScrollTop = input(0);
  /** Review scope the mention belongs to, mirroring the diff panel's. */
  readonly scope = input<DiffSelectionMentionScope>('branch');
  /** Diff identity of the file, so anchors line up with diff-made ones. */
  readonly changeHash = input<string | null>(null);
  readonly selectionActions = input<readonly DiffSelectionMenuAction[]>(
    DEFAULT_DIFF_SELECTION_ACTIONS,
  );

  readonly scrolled = output<number>();
  readonly selectionAction = output<{
    id: string;
    mentions: DiffSelectionMention[];
  }>();

  private readonly files = inject(FilesService);
  private readonly scrollRef = viewChild<ElementRef<HTMLElement>>('scrollRef');

  readonly content = signal('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly selectionMenu = signal<SelectionMenuState | null>(null);

  constructor() {
    effect(() => {
      const worktreePath = this.worktreePath();
      const path = this.path();
      this.selectionMenu.set(null);
      void this.load(worktreePath, path);
    });

    effect(() => {
      this.content();
      const offset = this.restoreScrollTop();
      if (!offset) return;
      requestAnimationFrame(() => {
        const element = this.scrollRef()?.nativeElement;
        if (element) element.scrollTop = offset;
      });
    });
  }

  /**
   * Turn the current text selection into a mention and place the action bar
   * above it. Anything that is not a real selection inside the document simply
   * dismisses the bar.
   */
  captureSelection(): void {
    const scrollEl = this.scrollRef()?.nativeElement;
    const selection = window.getSelection();
    if (!scrollEl || !selection || selection.isCollapsed || !selection.rangeCount) {
      this.selectionMenu.set(null);
      return;
    }

    const { anchorNode, focusNode } = selection;
    if (
      !anchorNode ||
      !focusNode ||
      !scrollEl.contains(anchorNode) ||
      !scrollEl.contains(focusNode)
    ) {
      this.selectionMenu.set(null);
      return;
    }

    const mention = buildMarkdownSelectionMention({
      filePath: this.path(),
      scope: this.scope(),
      changeHash: this.changeHash(),
      content: this.content(),
      selectedText: selection.toString(),
    });
    if (!mention) {
      this.selectionMenu.set(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const selectionRect =
      typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : scrollEl.getBoundingClientRect();
    const containerRect = scrollEl.getBoundingClientRect();
    this.selectionMenu.set({
      top: Math.max(
        8,
        selectionRect.top - containerRect.top + scrollEl.scrollTop - MENU_OFFSET_PX,
      ),
      left: Math.max(8, selectionRect.left - containerRect.left + scrollEl.scrollLeft),
      mentions: [mention],
    });
  }

  onSelectionMenuAction(event: { id: string; mentions: DiffSelectionMention[] }): void {
    this.selectionAction.emit(event);
    this.selectionMenu.set(null);
    window.getSelection()?.removeAllRanges();
  }

  private async load(worktreePath: string, path: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const file = await firstValueFrom(this.files.readFile(worktreePath, path));
      if (this.path() !== path) return;
      this.content.set(file.content);
    } catch {
      if (this.path() === path) {
        this.error.set('Could not read this file.');
        this.content.set('');
      }
    } finally {
      if (this.path() === path) this.loading.set(false);
    }
  }
}
