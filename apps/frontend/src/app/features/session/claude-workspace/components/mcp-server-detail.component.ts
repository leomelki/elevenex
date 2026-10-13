import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideGlobe,
  lucideKeyRound,
  lucidePencil,
  lucideTerminal,
  lucideTrash2,
  lucideRefreshCw,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import type { AgentMcpServerEntry } from '@/shared/models/agent-runtime.model';
import type { McpOperation } from '../mcp-manager.store';
import { MCP_SCOPE_LABELS } from './mcp-presentation';
import { McpServerStatusComponent } from './mcp-server-status.component';

/** Owns server details, capability-based actions, and removal confirmation. */
@Component({
  selector: 'cw-mcp-server-detail',
  imports: [NgIcon, ZardButtonComponent, ZardInputDirective, McpServerStatusComponent],
  templateUrl: './mcp-server-detail.component.html',
  host: { class: 'block min-w-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideGlobe,
      lucideKeyRound,
      lucidePencil,
      lucideTerminal,
      lucideTrash2,
      lucideRefreshCw,
    }),
  ],
})
export class McpServerDetailComponent {
  readonly entry = input.required<AgentMcpServerEntry>();
  readonly provider = input('claude');
  readonly busyId = input<string | null>(null);
  readonly operation = input<McpOperation | null>(null);
  readonly authenticate = output<AgentMcpServerEntry>();
  readonly check = output<AgentMcpServerEntry>();
  readonly edit = output<AgentMcpServerEntry>();
  readonly toggle = output<AgentMcpServerEntry>();
  readonly remove = output<AgentMcpServerEntry>();
  readonly removing = signal(false);
  readonly toolQuery = signal('');
  readonly allTools = signal(false);
  readonly filteredTools = computed(() => {
    const query = this.toolQuery().trim().toLowerCase();
    return (this.entry().tools ?? []).filter(
      (tool) => !query || `${tool.name} ${tool.displayName}`.toLowerCase().includes(query),
    );
  });
  readonly visibleTools = computed(() =>
    this.allTools() ? this.filteredTools() : this.filteredTools().slice(0, 50),
  );
  private readonly entryId = computed(() => this.entry().entryId);
  readonly providerLabel = computed(
    () =>
      ({ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' })[this.provider()] ??
      this.provider(),
  );
  readonly scopeLabels = MCP_SCOPE_LABELS;

  constructor() {
    effect(() => {
      this.entryId();
      this.removing.set(false);
      this.toolQuery.set('');
      this.allTools.set(false);
    });
  }
}
