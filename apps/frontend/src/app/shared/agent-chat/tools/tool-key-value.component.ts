import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'cw-tool-kv',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cw-tool__kv grid gap-0.5 font-mono text-xs">
      @for (entry of entries(); track entry.k) {
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 px-1 py-0.5">
          <span class="text-muted-foreground">{{ entry.k }}</span>
          <span class="whitespace-pre-wrap wrap-break-word">{{ entry.v }}</span>
        </div>
      }
    </div>
  `,
})
export class ToolKeyValueComponent {
  readonly entries = input.required<readonly { readonly k: string; readonly v: string }[]>();
}
