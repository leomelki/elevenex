import {
  highlightedPatchHtml,
  highlightedUnifiedDiffHtml,
} from '@/shared/agent-chat/tools/code-highlight';
import { InlineDiffComponent } from '@/shared/agent-chat/tools/inline-diff.component';
import {
  TurnChangeDetails,
  TurnChangedFile,
  TurnChangeHunk,
} from '@/shared/agent-chat/tools/turn-change-stats';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronRight, lucideFilePen, lucideMessagesSquare, lucideX } from '@ng-icons/lucide';
import DOMPurify from 'dompurify';

interface RenderedHunk extends TurnChangeHunk {
  html: SafeHtml | null;
}

interface RenderedFile extends TurnChangedFile {
  basename: string;
  folder: string;
  statusLabel: string;
  statusGlyph: string;
  hunks: RenderedHunk[];
}

@Component({
  selector: 'cw-turn-changes',
  standalone: true,
  imports: [CommonModule, NgIcon, InlineDiffComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideChevronRight,
      lucideFilePen,
      lucideMessagesSquare,
      lucideX,
    }),
  ],
  templateUrl: './claude-turn-changes.component.html',
  styleUrl: './claude-turn-changes.component.scss',
})
export class ClaudeTurnChangesComponent {
  readonly details = input.required<TurnChangeDetails>();
  /** Open discussions anchored to this turn, shown as a badge. */
  readonly threadCount = input(0);
  readonly canReview = input(false);
  readonly close = output<void>();
  /** Open these changes in the review workspace, optionally on one file. */
  readonly review = output<{ path?: string }>();

  private readonly sanitizer = inject(DomSanitizer);
  private readonly openFiles = signal<Record<string, boolean>>({});

  readonly renderedFiles = computed<RenderedFile[]>(() =>
    this.details().filesChanged.map((file, index) => {
      const pathParts = file.path.split(/[\\/]/).filter(Boolean);
      const basename = pathParts.pop() ?? file.path;
      return {
        ...file,
        basename,
        folder: pathParts.length ? pathParts.join('/') : '',
        statusLabel: this.statusLabel(file.status),
        statusGlyph: this.statusGlyph(file.status),
        hunks: file.hunks.map((hunk) => ({
          ...hunk,
          html: this.isFileOpen(file.path, index) ? this.renderHunkHtml(file.path, hunk) : null,
        })),
      };
    }),
  );

  isFileOpen(path: string, index: number): boolean {
    const explicit = this.openFiles()[path];
    return explicit ?? index === 0;
  }

  toggleFile(path: string, index: number): void {
    this.openFiles.update((current) => ({
      ...current,
      [path]: !(current[path] ?? index === 0),
    }));
  }

  private renderHunkHtml(filePath: string, hunk: TurnChangeHunk): SafeHtml | null {
    const raw = hunk.patch
      ? highlightedPatchHtml(hunk.patch, filePath)
      : hunk.oldString || hunk.newString
        ? highlightedUnifiedDiffHtml(hunk.oldString, hunk.newString, filePath, {
            oldStartLine: hunk.oldStartLine ?? hunk.startLine,
            newStartLine: hunk.newStartLine ?? hunk.startLine,
          })
        : '';
    if (!raw) return null;
    const safe = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
    return this.sanitizer.bypassSecurityTrustHtml(safe);
  }

  private statusLabel(status: TurnChangedFile['status']): string {
    if (status === 'created') return 'Created';
    if (status === 'deleted') return 'Deleted';
    return 'Modified';
  }

  private statusGlyph(status: TurnChangedFile['status']): string {
    if (status === 'created') return 'A';
    if (status === 'deleted') return 'D';
    return 'M';
  }
}
