import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronRight,
  lucideFilePen,
  lucideX,
} from '@ng-icons/lucide';
import {
  TurnChangedFile,
  TurnChangeDetails,
  TurnChangeHunk,
} from '../util/turn-change-stats';
import {
  highlightedPatchHtml,
  highlightedUnifiedDiffHtml,
} from '../util/code-highlight';

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
  imports: [CommonModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideChevronRight,
      lucideFilePen,
      lucideX,
    }),
  ],
  template: `
    <section class="cw-turn-changes" aria-label="Changes made in this turn">
      <header class="cw-turn-changes__head">
        <div class="cw-turn-changes__title">
          <span class="cw-turn-changes__icon" aria-hidden="true">
            <ng-icon name="lucideFilePen" size="14" />
          </span>
          <div class="cw-turn-changes__copy">
            <span class="cw-turn-changes__label">Changes in this turn</span>
            <span class="cw-turn-changes__summary">
              {{ details().files }} file{{ details().files === 1 ? '' : 's' }}
              <span class="cw-turn-changes__add">+{{ details().additions }}</span>
              <span class="cw-turn-changes__del">-{{ details().deletions }}</span>
            </span>
          </div>
        </div>
        <button
          type="button"
          class="cw-turn-changes__close"
          aria-label="Close changes"
          title="Close changes"
          (click)="close.emit()"
        >
          <ng-icon name="lucideX" size="14" />
        </button>
      </header>

      <div class="cw-turn-changes__files">
        @for (file of renderedFiles(); track file.path; let i = $index) {
          <article class="cw-turn-changes__file" [attr.data-status]="file.status">
            <button
              type="button"
              class="cw-turn-changes__file-head"
              [attr.aria-expanded]="isFileOpen(file.path, i)"
              [title]="file.path"
              (click)="toggleFile(file.path, i)"
            >
              <ng-icon
                class="cw-turn-changes__chevron"
                name="lucideChevronRight"
                size="14"
                [class.cw-turn-changes__chevron--open]="isFileOpen(file.path, i)"
                aria-hidden="true"
              />
              <span class="cw-turn-changes__status">{{ file.statusGlyph }}</span>
              <span class="cw-turn-changes__path">
                <span class="cw-turn-changes__base">{{ file.basename }}</span>
                @if (file.folder) {
                  <span class="cw-turn-changes__folder">{{ file.folder }}</span>
                }
              </span>
              <span class="cw-turn-changes__file-meta">{{ file.statusLabel }}</span>
              <span class="cw-turn-changes__file-stats">
                <span class="cw-turn-changes__add">+{{ file.additions }}</span>
                <span class="cw-turn-changes__del">-{{ file.deletions }}</span>
              </span>
            </button>

            @if (isFileOpen(file.path, i)) {
              <div class="cw-turn-changes__file-body">
                @for (hunk of file.hunks; track hunk.id) {
                  <div class="cw-turn-changes__hunk">
                    <div class="cw-turn-changes__hunk-head">
                      <span>{{ hunk.label }}</span>
                      <span class="cw-turn-changes__hunk-stats">
                        <span class="cw-turn-changes__add">+{{ hunk.additions }}</span>
                        <span class="cw-turn-changes__del">-{{ hunk.deletions }}</span>
                      </span>
                    </div>
                    @if (hunk.html) {
                      <pre class="cw-turn-changes__diff" [innerHTML]="hunk.html"></pre>
                    } @else {
                      <div class="cw-turn-changes__empty-diff">
                        Inline diff was not captured for this file.
                      </div>
                    }
                  </div>
                }
              </div>
            }
          </article>
        }
      </div>
    </section>
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
    }

    .cw-turn-changes {
      overflow: hidden;
      border: 1px solid color-mix(in oklab, var(--border) 90%, transparent);
      border-radius: 0.75rem;
      background: color-mix(in oklab, var(--card) 94%, var(--background));
      box-shadow: 0 16px 40px -30px color-mix(in oklab, var(--foreground) 45%, transparent);
    }

    .cw-turn-changes__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.65rem 0.75rem;
      border-bottom: 1px solid color-mix(in oklab, var(--border) 75%, transparent);
      background: color-mix(in oklab, var(--background) 48%, transparent);
    }

    .cw-turn-changes__title {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      min-width: 0;
    }

    .cw-turn-changes__icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.5rem;
      height: 1.5rem;
      flex-shrink: 0;
      border-radius: 0.45rem;
      background: color-mix(in oklab, var(--primary) 12%, transparent);
      color: color-mix(in oklab, var(--primary) 82%, var(--foreground));
    }

    .cw-turn-changes__copy {
      display: flex;
      align-items: baseline;
      gap: 0.45rem;
      min-width: 0;
    }

    .cw-turn-changes__label {
      color: var(--foreground);
      font-size: 0.78rem;
      font-weight: 650;
    }

    .cw-turn-changes__summary,
    .cw-turn-changes__file-meta,
    .cw-turn-changes__hunk-stats {
      color: var(--muted-foreground);
      font-size: 0.72rem;
      white-space: nowrap;
    }

    .cw-turn-changes__close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.75rem;
      height: 1.75rem;
      border: 1px solid transparent;
      border-radius: 0.45rem;
      background: transparent;
      color: var(--muted-foreground);
      cursor: pointer;
      transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
    }

    .cw-turn-changes__close:hover,
    .cw-turn-changes__close:focus-visible {
      border-color: color-mix(in oklab, var(--border) 85%, transparent);
      background: color-mix(in oklab, var(--foreground) 6%, transparent);
      color: var(--foreground);
      outline: none;
    }

    .cw-turn-changes__files {
      display: flex;
      flex-direction: column;
    }

    .cw-turn-changes__file + .cw-turn-changes__file {
      border-top: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
    }

    .cw-turn-changes__file-head {
      display: grid;
      grid-template-columns: auto auto minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      min-height: 2.45rem;
      padding: 0.5rem 0.75rem;
      border: 0;
      background: transparent;
      color: var(--foreground);
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition: background-color 120ms ease;
    }

    .cw-turn-changes__file-head:hover,
    .cw-turn-changes__file-head:focus-visible {
      background: color-mix(in oklab, var(--foreground) 4%, transparent);
      outline: none;
    }

    .cw-turn-changes__chevron {
      display: inline-flex;
      color: var(--muted-foreground);
      transition: transform 140ms ease;
    }

    .cw-turn-changes__chevron--open {
      transform: rotate(90deg);
    }

    .cw-turn-changes__status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.15rem;
      height: 1.15rem;
      border-radius: 0.35rem;
      background: color-mix(in oklab, var(--foreground) 7%, transparent);
      color: var(--muted-foreground);
      font-size: 0.66rem;
      font-weight: 700;
    }

    .cw-turn-changes__file[data-status='created'] .cw-turn-changes__status {
      background: color-mix(in oklab, var(--success) 15%, transparent);
      color: color-mix(in oklab, var(--success) 82%, var(--foreground));
    }

    .cw-turn-changes__file[data-status='deleted'] .cw-turn-changes__status {
      background: color-mix(in oklab, var(--destructive) 13%, transparent);
      color: var(--destructive);
    }

    .cw-turn-changes__path {
      display: flex;
      align-items: baseline;
      gap: 0.45rem;
      min-width: 0;
      overflow: hidden;
    }

    .cw-turn-changes__base {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.78rem;
      font-weight: 600;
    }

    .cw-turn-changes__folder {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted-foreground);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
    }

    .cw-turn-changes__file-stats {
      display: inline-flex;
      align-items: baseline;
      gap: 0.3rem;
      font-size: 0.72rem;
      font-weight: 650;
      white-space: nowrap;
    }

    .cw-turn-changes__add {
      color: color-mix(in oklab, var(--success) 80%, var(--foreground));
      font-weight: 650;
    }

    .cw-turn-changes__del {
      color: color-mix(in oklab, var(--destructive) 82%, var(--foreground));
      font-weight: 650;
    }

    .cw-turn-changes__file-body {
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
      padding: 0 0.75rem 0.75rem 2.6rem;
    }

    .cw-turn-changes__hunk {
      overflow: hidden;
      border: 1px solid color-mix(in oklab, var(--border) 82%, transparent);
      border-radius: 0.5rem;
      background: color-mix(in oklab, var(--background) 78%, transparent);
    }

    .cw-turn-changes__hunk-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.4rem 0.55rem;
      border-bottom: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
      color: var(--muted-foreground);
      font-size: 0.7rem;
      font-weight: 600;
    }

    .cw-turn-changes__diff {
      margin: 0;
      max-height: 28rem;
      overflow: auto;
      background: color-mix(in oklab, var(--background) 88%, var(--surface-shade));
      color: var(--foreground);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      line-height: 1.55;
      white-space: pre;
    }

    .cw-turn-changes__empty-diff {
      padding: 0.65rem 0.75rem;
      color: var(--muted-foreground);
      font-size: 0.76rem;
      background: color-mix(in oklab, var(--foreground) 4%, transparent);
    }

    :host ::ng-deep .cw-diff-line {
      display: grid;
      grid-template-columns: 2.5rem 2.5rem 1.15rem minmax(0, 1fr);
      min-width: max-content;
    }

    :host ::ng-deep .cw-diff-ln,
    :host ::ng-deep .cw-diff-marker {
      user-select: none;
      color: var(--muted-foreground);
      background: color-mix(in oklab, var(--foreground) 3%, transparent);
    }

    :host ::ng-deep .cw-diff-ln {
      padding: 0 0.45rem;
      text-align: right;
      border-right: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
    }

    :host ::ng-deep .cw-diff-marker {
      padding: 0 0.25rem;
      text-align: center;
    }

    :host ::ng-deep .cw-diff-code {
      padding: 0 0.75rem 0 0.5rem;
      min-width: 0;
    }

    :host ::ng-deep .cw-diff-add {
      background: color-mix(in oklab, var(--success) 10%, transparent);
    }

    :host ::ng-deep .cw-diff-add .cw-diff-marker {
      color: color-mix(in oklab, var(--success) 85%, var(--foreground));
    }

    :host ::ng-deep .cw-diff-del {
      background: color-mix(in oklab, var(--destructive) 10%, transparent);
    }

    :host ::ng-deep .cw-diff-del .cw-diff-marker {
      color: color-mix(in oklab, var(--destructive) 85%, var(--foreground));
    }

    :host ::ng-deep .cw-diff-hunk {
      color: color-mix(in oklab, var(--primary) 78%, var(--foreground));
      background: color-mix(in oklab, var(--primary) 8%, transparent);
    }

    @container cw-workspace (max-width: 42rem) {
      .cw-turn-changes__copy {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.12rem;
      }

      .cw-turn-changes__file-head {
        grid-template-columns: auto auto minmax(0, 1fr) auto;
      }

      .cw-turn-changes__file-meta {
        display: none;
      }

      .cw-turn-changes__folder {
        display: none;
      }

      .cw-turn-changes__file-body {
        padding-left: 0.75rem;
      }

      :host ::ng-deep .cw-diff-line {
        grid-template-columns: 2rem 2rem 1rem minmax(0, 1fr);
      }
    }
  `],
})
export class ClaudeTurnChangesComponent {
  readonly details = input.required<TurnChangeDetails>();
  readonly close = output<void>();

  private readonly sanitizer = inject(DomSanitizer);
  private readonly openFiles = signal<Record<string, boolean>>({});

  readonly renderedFiles = computed<RenderedFile[]>(() =>
    this.details().filesChanged.map((file) => {
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
          html: this.renderHunkHtml(file.path, hunk),
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
        ? highlightedUnifiedDiffHtml(hunk.oldString, hunk.newString, filePath)
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
