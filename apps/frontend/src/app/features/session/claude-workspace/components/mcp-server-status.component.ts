import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { AgentMcpServerEntry } from '@/shared/models/agent-runtime.model';
import { mcpStatus } from './mcp-presentation';

@Component({
  selector: 'cw-mcp-server-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex min-w-0' },
  template: `
    <span
      class="inline-flex items-center gap-1.5 text-xs"
      [class.text-success]="status().tone === 'success'"
      [class.text-warning]="status().tone === 'warning'"
      [class.text-destructive]="status().tone === 'error'"
      [class.text-muted-foreground]="status().tone === 'muted'"
    >
      <span class="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true"></span>
      <span>{{ status().label }}</span>
    </span>
  `,
})
export class McpServerStatusComponent {
  readonly entry = input.required<AgentMcpServerEntry>();
  readonly provider = input('claude');
  readonly status = computed(() => mcpStatus(this.entry(), this.provider()));
}
