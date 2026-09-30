import {
  ClaudeMcpDiagnosticGroup,
  ClaudeMcpServerEntry,
  ClaudeMcpSnapshot,
} from '@/shared/models/claude-runtime.model';
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBadgeAlert,
  lucideCircleCheck,
  lucideKeyRound,
  lucideLoaderCircle,
  lucidePlugZap,
  lucideRefreshCcw,
  lucideShieldAlert,
  lucideTriangleAlert,
  lucideWrench,
  lucideX,
} from '@ng-icons/lucide';

@Component({
  selector: 'cw-mcp-drawer',
  standalone: true,
  imports: [CommonModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideBadgeAlert,
      lucideCircleCheck,
      lucideKeyRound,
      lucideLoaderCircle,
      lucidePlugZap,
      lucideRefreshCcw,
      lucideShieldAlert,
      lucideTriangleAlert,
      lucideWrench,
      lucideX,
    }),
  ],
  templateUrl: './claude-mcp-drawer.component.html',
  styleUrl: './claude-mcp-drawer.component.scss',
})
export class ClaudeMcpDrawerComponent {
  readonly open = input<boolean>(false);
  readonly loading = input<boolean>(false);
  readonly snapshot = input<ClaudeMcpSnapshot | null>(null);
  readonly busyServerName = input<string | null>(null);

  readonly close = output<void>();
  readonly refresh = output<void>();
  readonly toggle = output<ClaudeMcpServerEntry>();
  readonly recheck = output<ClaudeMcpServerEntry>();
  readonly auth = output<ClaudeMcpServerEntry>();

  readonly groupedServers = computed(() => {
    const servers = this.snapshot()?.servers ?? [];
    return [
      { scope: 'project', label: 'Project', servers: servers.filter((s) => s.scope === 'project') },
      { scope: 'local', label: 'Local', servers: servers.filter((s) => s.scope === 'local') },
      { scope: 'user', label: 'User', servers: servers.filter((s) => s.scope === 'user') },
      {
        scope: 'enterprise',
        label: 'Enterprise',
        servers: servers.filter((s) => s.scope === 'enterprise'),
      },
      {
        scope: 'runtime',
        label: 'Runtime / Other',
        servers: servers.filter((s) => s.scope === 'runtime'),
      },
    ].filter((g) => g.servers.length > 0);
  });

  readonly expandedTools = signal<Record<string, boolean>>({});

  statusLabel(server: ClaudeMcpServerEntry): string {
    return server.connectionStatus.replace('-', ' ');
  }

  scopeLabel(scope: ClaudeMcpDiagnosticGroup['scope']): string {
    const labels: Record<string, string> = {
      project: 'Project',
      local: 'Local',
      user: 'User',
      enterprise: 'Enterprise',
    };
    return labels[scope] ?? 'Runtime / Other';
  }

  diagnosticKey(message: { serverName?: string; path?: string; message: string }): string {
    return `${message.serverName ?? 'file'}:${message.path ?? ''}:${message.message}`;
  }

  diagnosticMessage(message: { serverName?: string; path?: string; message: string }): string {
    return [message.serverName, message.path, message.message].filter(Boolean).join(' · ');
  }
}
