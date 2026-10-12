import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBot, lucideArrowUpRight } from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import type { AgentSubagentState } from '@/shared/models/agent-runtime.model';
import { SubagentStatusComponent, agentLabel } from './subagent-status.component';

@Component({
  selector: 'cw-subagent-overview',
  imports: [ZardButtonComponent, NgIcon, SubagentStatusComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideBot, lucideArrowUpRight })],
  templateUrl: './subagent-overview.component.html',
})
export class SubagentOverviewComponent {
  readonly agents = input.required<AgentSubagentState[]>();
  readonly inspect = output<string>();
  readonly running = computed(() => this.agents().filter((agent) => agent.status === 'started'));
  readonly attention = computed(
    () =>
      this.agents().filter((agent) =>
        ['error', 'interrupted', 'waiting', 'unavailable'].includes(agent.executionStatus ?? ''),
      ).length,
  );
  readonly featured = computed(() =>
    [...this.agents()]
      .sort(
        (a, b) =>
          Number(b.status === 'started') - Number(a.status === 'started') ||
          b.timestamp.localeCompare(a.timestamp),
      )
      .slice(0, 3),
  );
  protected readonly agentLabel = agentLabel;
}
