import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { SafeHtml } from '@angular/platform-browser';

@Component({
  selector: 'cw-inline-diff',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './inline-diff.component.html',
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
