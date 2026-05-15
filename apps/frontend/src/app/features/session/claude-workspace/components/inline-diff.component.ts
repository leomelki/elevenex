import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { SafeHtml } from '@angular/platform-browser';

@Component({
  selector: 'cw-inline-diff',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="cw-inline-diff">
      @if (label() || hasStats()) {
        <header class="cw-inline-diff__head">
          @if (label()) {
            <span class="cw-inline-diff__label" [title]="label()">{{ label() }}</span>
          }
          @if (hasStats()) {
            <span class="cw-inline-diff__stats">
              <span class="cw-inline-diff__add">+{{ additions() ?? 0 }}</span>
              <span class="cw-inline-diff__del">-{{ deletions() ?? 0 }}</span>
            </span>
          }
        </header>
      }

      @if (html()) {
        <pre class="cw-inline-diff__body" [innerHTML]="html()"></pre>
      } @else {
        <div class="cw-inline-diff__empty">{{ emptyText() }}</div>
      }
    </section>
  `,
  styles: [`
    .cw-inline-diff {
      overflow: hidden;
      border: 1px solid color-mix(in oklab, var(--border) 82%, transparent);
      border-radius: 0.5rem;
      background: color-mix(in oklab, var(--background) 78%, transparent);
    }

    .cw-inline-diff__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      min-width: 0;
      padding: 0.4rem 0.55rem;
      border-bottom: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
      color: var(--muted-foreground);
      font-size: 0.7rem;
      font-weight: 600;
    }

    .cw-inline-diff__label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .cw-inline-diff__stats {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      flex-shrink: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .cw-inline-diff__add {
      color: color-mix(in oklab, var(--success) 86%, var(--foreground));
    }

    .cw-inline-diff__del {
      color: color-mix(in oklab, var(--destructive) 86%, var(--foreground));
    }

    .cw-inline-diff__body {
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

    .cw-inline-diff__empty {
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
      :host ::ng-deep .cw-diff-line {
        grid-template-columns: 2rem 2rem 1rem minmax(0, 1fr);
      }
    }
  `],
})
export class InlineDiffComponent {
  readonly html = input<SafeHtml | string | null>(null);
  readonly label = input('');
  readonly additions = input<number | null>(null);
  readonly deletions = input<number | null>(null);
  readonly emptyText = input('Inline diff was not captured.');

  readonly hasStats = computed(() => this.additions() !== null || this.deletions() !== null);
}
