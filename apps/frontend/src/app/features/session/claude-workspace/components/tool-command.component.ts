import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'cw-tool-command',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .cw-tool__cmd {
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
  `],
  template: `<pre class="cw-tool__cmd">$ {{ command() }}</pre>`,
})
export class ToolCommandComponent {
  readonly command = input.required<string>();
}
