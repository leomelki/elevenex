import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'cw-tool-output',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .cw-tool__output {
      margin: 0;
      padding: 0.5rem 0.625rem;
      background: color-mix(in oklab, var(--foreground) 5%, transparent);
      border-radius: 0.375rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 24rem;
      overflow: auto;
    }
    .cw-tool__output--error {
      background: color-mix(in oklab, var(--destructive) 8%, transparent);
      color: var(--destructive);
    }
  `],
  template: `
    <pre class="cw-tool__output" [class.cw-tool__output--error]="error()">{{ text() }}</pre>
  `,
})
export class ToolOutputComponent {
  readonly text = input.required<string>();
  readonly error = input(false);
}
