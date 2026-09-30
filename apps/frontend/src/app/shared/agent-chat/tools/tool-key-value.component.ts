import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'cw-tool-kv',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './tool-key-value.component.scss',
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
