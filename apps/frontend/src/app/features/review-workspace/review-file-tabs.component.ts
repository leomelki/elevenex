import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBookOpen,
  lucideCode,
  lucideFileCode,
  lucideLayers,
  lucideX,
} from '@ng-icons/lucide';

export interface ReviewFileTab {
  path: string;
  /** Scroll offset of the diff area, restored when the tab is re-focused. */
  scrollTop: number;
  /** Markdown tabs remember whether the user left them on rendered preview. */
  preview: boolean;
  /** True for files with no diff in this scope, opened explicitly. */
  extra: boolean;
}

@Component({
  selector: 'app-review-file-tabs',
  standalone: true,
  imports: [CommonModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideBookOpen,
      lucideCode,
      lucideFileCode,
      lucideLayers,
      lucideX,
    }),
  ],
  template: `
    <div class="ft-bar" role="tablist" aria-label="Open files">
      <button
        type="button"
        role="tab"
        class="ft-tab ft-tab--all"
        [class.ft-tab--active]="activePath() === null"
        [attr.aria-selected]="activePath() === null"
        title="Show every changed file in one continuous scroll"
        (click)="selectAll.emit()"
      >
        <ng-icon name="lucideLayers" size="12" class="ft-tab__icon" />
        <span>All changes</span>
      </button>

      @for (tab of tabs(); track tab.path) {
        <div
          class="ft-tab"
          [class.ft-tab--active]="tab.path === activePath()"
          role="tab"
          [attr.aria-selected]="tab.path === activePath()"
          [title]="tab.path"
        >
          <button type="button" class="ft-tab__main" (click)="select.emit(tab.path)">
            <ng-icon name="lucideFileCode" size="12" class="ft-tab__icon" />
            <span class="ft-tab__label">{{ basename(tab.path) }}</span>
            @if (tab.extra) {
              <span class="ft-tab__badge" title="No changes in this scope">no diff</span>
            }
          </button>

          @if (isMarkdown(tab.path)) {
            <button
              type="button"
              class="ft-tab__toggle"
              [class.ft-tab__toggle--on]="tab.preview"
              [attr.aria-pressed]="tab.preview"
              [title]="tab.preview ? 'Show the diff' : 'Show rendered markdown'"
              [attr.aria-label]="tab.preview ? 'Show the diff' : 'Show rendered markdown'"
              (click)="togglePreview.emit(tab.path)"
            >
              <ng-icon [name]="tab.preview ? 'lucideCode' : 'lucideBookOpen'" size="11" />
            </button>
          }

          <button
            type="button"
            class="ft-tab__close"
            [attr.aria-label]="'Close ' + basename(tab.path)"
            (click)="close.emit(tab.path)"
          >
            <ng-icon name="lucideX" size="11" />
          </button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        flex-shrink: 0;
      }

      .ft-bar {
        display: flex;
        align-items: stretch;
        gap: 0.15rem;
        overflow-x: auto;
        padding: 0.25rem 0.35rem 0;
        border-bottom: 1px solid var(--border);
        background: color-mix(in oklch, var(--card) 35%, var(--background));
        scrollbar-width: thin;
      }

      .ft-tab {
        display: inline-flex;
        max-width: 14rem;
        flex-shrink: 0;
        align-items: center;
        border: 1px solid transparent;
        border-bottom: 0;
        border-radius: 0.4rem 0.4rem 0 0;
        color: var(--muted-foreground);
      }

      .ft-tab:hover {
        background: color-mix(in oklch, var(--muted) 50%, transparent);
      }

      .ft-tab--active {
        border-color: var(--border);
        background: var(--background);
        color: var(--foreground);
      }

      .ft-tab__main {
        display: inline-flex;
        min-width: 0;
        align-items: center;
        gap: 0.3rem;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
        font-size: 0.73rem;
        font-weight: 650;
        padding: 0.3rem 0.15rem 0.3rem 0.5rem;
      }

      .ft-tab__main:focus-visible,
      .ft-tab__toggle:focus-visible,
      .ft-tab__close:focus-visible {
        outline: none;
        box-shadow: inset 0 0 0 2px color-mix(in oklch, var(--primary) 45%, transparent);
      }

      .ft-tab__icon {
        flex-shrink: 0;
        opacity: 0.75;
      }

      .ft-tab__label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .ft-tab__badge {
        flex-shrink: 0;
        border-radius: 999px;
        background: color-mix(in oklch, var(--muted) 70%, transparent);
        color: var(--muted-foreground);
        font-size: 0.55rem;
        font-weight: 700;
        padding: 0.02rem 0.25rem;
      }

      .ft-tab__toggle,
      .ft-tab__close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.15rem;
        height: 1.15rem;
        flex-shrink: 0;
        border: 0;
        border-radius: 0.25rem;
        background: transparent;
        color: inherit;
        cursor: pointer;
        opacity: 0.65;
      }

      .ft-tab__toggle:hover,
      .ft-tab__close:hover {
        opacity: 1;
        background: color-mix(in oklch, var(--foreground) 10%, transparent);
      }

      .ft-tab__toggle--on {
        opacity: 1;
        color: var(--primary);
      }

      .ft-tab__close {
        margin-right: 0.3rem;
      }

      .ft-tab--all {
        gap: 0.3rem;
        border: 1px solid transparent;
        border-bottom: 0;
        background: transparent;
        color: var(--muted-foreground);
        cursor: pointer;
        font: inherit;
        font-size: 0.73rem;
        font-weight: 650;
        padding: 0.3rem 0.55rem;
      }

      .ft-tab--all.ft-tab--active {
        border-color: var(--border);
        background: var(--background);
        color: var(--foreground);
      }

      .ft-tab--all:focus-visible {
        outline: none;
        box-shadow: inset 0 0 0 2px color-mix(in oklch, var(--primary) 45%, transparent);
      }
    `,
  ],
})
export class ReviewFileTabsComponent {
  readonly tabs = input.required<readonly ReviewFileTab[]>();
  readonly activePath = input<string | null>(null);

  readonly select = output<string>();
  readonly selectAll = output<void>();
  readonly close = output<string>();
  readonly togglePreview = output<string>();

  basename(path: string): string {
    return path.split('/').pop() || path;
  }

  isMarkdown(path: string): boolean {
    return isMarkdownPath(path);
  }
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}
