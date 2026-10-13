import { A11yModule } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideCircleAlert,
  lucideGlobe,
  lucideLoaderCircle,
  lucidePlug,
  lucidePlus,
  lucideRefreshCw,
  lucideSearch,
  lucideTerminal,
  lucideX,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { ZardSkeletonComponent } from '@/shared/components/skeleton';
import type { AgentMcpServerEntry } from '@/shared/models/agent-runtime.model';
import { McpManagerStore } from '../mcp-manager.store';
import { MCP_SCOPE_LABELS, mcpNeedsAttention } from './mcp-presentation';
import { McpServerDetailComponent } from './mcp-server-detail.component';
import { McpServerEditorComponent } from './mcp-server-editor.component';
import { McpServerStatusComponent } from './mcp-server-status.component';

/** Presentation state only; session data and guarded navigation belong to the store. */
@Component({
  selector: 'cw-mcp-manager-panel',
  imports: [
    A11yModule,
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    ZardSkeletonComponent,
    McpServerEditorComponent,
    McpServerDetailComponent,
    McpServerStatusComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideArrowLeft,
      lucideCircleAlert,
      lucideGlobe,
      lucideLoaderCircle,
      lucidePlug,
      lucidePlus,
      lucideRefreshCw,
      lucideSearch,
      lucideTerminal,
      lucideX,
    }),
  ],
  templateUrl: './mcp-manager-panel.component.html',
  host: { class: 'block h-full w-full min-w-0' },
})
export class McpManagerPanelComponent {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly store = input.required<McpManagerStore>();
  readonly provider = input('claude');
  readonly query = signal('');
  readonly filter = signal<'all' | 'attention' | 'disabled'>('all');
  readonly showDetail = signal(false);
  readonly scopeLabels = MCP_SCOPE_LABELS;
  readonly providerLabel = computed(
    () =>
      ({ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' })[this.provider()] ??
      this.provider(),
  );
  readonly filteredServers = computed(() => {
    const query = this.query().trim().toLowerCase();
    return (this.store().snapshot()?.servers ?? []).filter(
      (server) =>
        (!query ||
          [server.name, server.endpoint, server.scope, this.scopeLabels[server.scope]].some(
            (value) => value?.toLowerCase().includes(query),
          )) &&
        (this.filter() === 'all' ||
          (this.filter() === 'attention' ? mcpNeedsAttention(server) : !server.enabled)),
    );
  });
  readonly selectedServer = computed<AgentMcpServerEntry | null>(
    () =>
      this.filteredServers().find((server) => server.entryId === this.store().selectedId()) ??
      this.filteredServers()[0] ??
      null,
  );
  readonly attentionCount = computed(
    () => this.store().snapshot()?.servers.filter(mcpNeedsAttention).length ?? 0,
  );

  constructor() {
    effect(() => {
      if (this.store().draft() || this.store().editorLoading()) this.showDetail.set(true);
    });
  }

  select(server: AgentMcpServerEntry): void {
    this.store().select(server);
    this.showDetail.set(true);
  }

  moveSelection(event: KeyboardEvent, index: number): void {
    const count = this.filteredServers().length;
    const next = {
      ArrowDown: Math.min(index + 1, count - 1),
      ArrowUp: Math.max(index - 1, 0),
      Home: 0,
      End: count - 1,
    }[event.key];
    if (next === undefined || this.store().busy() || this.store().editorLoading()) return;
    event.preventDefault();
    this.select(this.filteredServers()[next]);
    if (!this.store().discardPending())
      this.element.nativeElement
        .querySelectorAll<HTMLButtonElement>('[data-mcp-server]')
        [next]?.focus();
  }

  back(): void {
    this.store().cancelEditor(() => this.showDetail.set(false));
  }

  escape(event: Event): void {
    event.stopPropagation();
    const store = this.store();
    if (store.busy()) return;
    if (store.discardPending()) store.keepEditing();
    else if (store.draft()) store.cancelEditor();
    else store.close();
  }
}
