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
  styleUrl: './inline-diff.component.scss',
})
export class InlineDiffComponent {
  readonly html = input<SafeHtml | string | null>(null);
  readonly label = input('');
  readonly additions = input<number | null>(null);
  readonly deletions = input<number | null>(null);
  readonly emptyText = input('Inline diff was not captured.');

  readonly hasStats = computed(() => this.additions() !== null || this.deletions() !== null);
}
