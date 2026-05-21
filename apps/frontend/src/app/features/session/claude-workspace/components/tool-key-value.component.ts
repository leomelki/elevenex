import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'cw-tool-kv',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .cw-tool__kv {
      display: grid;
      gap: 0.125rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
    }
    .cw-tool__kv-row {
      display: grid;
      grid-template-columns: 8rem 1fr;
      gap: 0.5rem;
      padding: 0.125rem 0.25rem;
    }
    .cw-tool__kv-key {
      color: var(--muted-foreground);
    }
    .cw-tool__kv-val {
      white-space: pre-wrap;
      word-break: break-word;
    }
  `],
  template: `
    <div class="cw-tool__kv">
      @for (entry of entries(); track entry.k) {
        <div class="cw-tool__kv-row">
          <span class="cw-tool__kv-key">{{ entry.k }}</span>
          <span class="cw-tool__kv-val">{{ entry.v }}</span>
        </div>
      }
    </div>
  `,
})
export class ToolKeyValueComponent {
  readonly entries = input.required<Array<{ k: string; v: string }>>();
}
