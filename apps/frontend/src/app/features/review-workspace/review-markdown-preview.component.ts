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
import { FilesService } from '@/shared/services/files.service';
import { MarkdownPipe } from '@/features/session/claude-workspace/pipes/markdown.pipe';

/**
 * Rendered view of a markdown file in the worktree.
 *
 * Reads the file rather than reassembling it from diff rows: rows are windowed,
 * so a long document would render only the parts that happen to be loaded.
 * That means this always shows the file as it is on disk now, which is what
 * you want when reading a doc — the diff tab remains the place to see changes.
 */
@Component({
  selector: 'app-review-markdown-preview',
  standalone: true,
  imports: [CommonModule, NgIcon, MarkdownPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideRefreshCw, lucideTriangleAlert })],
  template: `
    <div class="mp-root">
      @if (loading()) {
        <div class="mp-status">
          <ng-icon name="lucideRefreshCw" size="14" class="mp-spin" />
          Loading…
        </div>
      } @else if (error(); as message) {
        <div class="mp-status mp-status--error" role="alert">
          <ng-icon name="lucideTriangleAlert" size="14" />
          {{ message }}
        </div>
      } @else {
        <article #scrollRef class="mp-doc" (scroll)="scrolled.emit(scrollRef.scrollTop)">
          <div class="mp-md" [innerHTML]="content() | cwMarkdown: worktreePath()"></div>
        </article>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
      }

      .mp-root {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
        background: var(--background);
      }

      .mp-status {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        padding: 2rem 1rem;
        color: var(--muted-foreground);
        font-size: 0.8rem;
      }

      .mp-status--error {
        color: var(--destructive);
      }

      .mp-spin {
        animation: mp-spin 1s linear infinite;
      }

      @keyframes mp-spin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .mp-spin {
          animation: none;
        }
      }

      .mp-doc {
        min-height: 0;
        flex: 1;
        overflow-y: auto;
        padding: 1.25rem clamp(1rem, 5%, 2.5rem) 3rem;
      }

      /* Rendered document styling: utilities cannot reach markdown output. */
      .mp-md {
        max-width: 48rem;
        margin: 0 auto;
        color: var(--foreground);
        font-size: 0.86rem;
        line-height: 1.65;
      }

      .mp-md :first-child {
        margin-top: 0;
      }

      .mp-md h1,
      .mp-md h2,
      .mp-md h3,
      .mp-md h4 {
        margin: 1.6em 0 0.6em;
        font-weight: 700;
        line-height: 1.25;
      }

      .mp-md h1 {
        font-size: 1.6em;
        padding-bottom: 0.3em;
        border-bottom: 1px solid var(--border);
      }

      .mp-md h2 {
        font-size: 1.3em;
        padding-bottom: 0.25em;
        border-bottom: 1px solid color-mix(in oklch, var(--border) 70%, transparent);
      }

      .mp-md h3 {
        font-size: 1.1em;
      }

      .mp-md p,
      .mp-md ul,
      .mp-md ol,
      .mp-md blockquote,
      .mp-md table {
        margin: 0.85em 0;
      }

      .mp-md ul,
      .mp-md ol {
        padding-left: 1.5em;
      }

      .mp-md li + li {
        margin-top: 0.25em;
      }

      .mp-md a {
        color: var(--primary);
        text-decoration: underline;
        text-underline-offset: 2px;
      }

      .mp-md blockquote {
        border-left: 3px solid color-mix(in oklch, var(--primary) 45%, var(--border));
        background: color-mix(in oklch, var(--muted) 35%, transparent);
        border-radius: 0 0.4rem 0.4rem 0;
        color: var(--muted-foreground);
        padding: 0.5em 0.9em;
      }

      .mp-md code {
        border-radius: 0.3rem;
        background: color-mix(in oklch, var(--foreground) 8%, transparent);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.86em;
        padding: 0.1em 0.35em;
      }

      .mp-md pre {
        overflow-x: auto;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--card);
        padding: 0.75em 0.9em;
      }

      .mp-md pre code {
        background: transparent;
        padding: 0;
        font-size: 0.82em;
      }

      .mp-md table {
        width: 100%;
        border-collapse: collapse;
        display: block;
        overflow-x: auto;
      }

      .mp-md th,
      .mp-md td {
        border: 1px solid var(--border);
        padding: 0.4em 0.6em;
        text-align: left;
      }

      .mp-md th {
        background: color-mix(in oklch, var(--muted) 45%, transparent);
        font-weight: 700;
      }

      .mp-md hr {
        margin: 1.75em 0;
        border: 0;
        border-top: 1px solid var(--border);
      }

      .mp-md img {
        max-width: 100%;
        border-radius: 0.4rem;
      }
    `,
  ],
})
export class ReviewMarkdownPreviewComponent {
  readonly worktreePath = input.required<string>();
  readonly path = input.required<string>();
  /** Scroll offset to restore when this tab is re-focused. */
  readonly restoreScrollTop = input(0);

  readonly scrolled = output<number>();

  private readonly files = inject(FilesService);
  private readonly scrollRef = viewChild<ElementRef<HTMLElement>>('scrollRef');

  readonly content = signal('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const worktreePath = this.worktreePath();
      const path = this.path();
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
