import { agentLabel } from '@/shared/agent-tools/agent-label';
import { SubagentIdentityComponent } from '@/shared/agent-chat/activity/subagent-identity.component';
import type { TurnAgentSummary } from '@/shared/agent-chat/activity/agent-deep-dive';
import type { TurnChangeDetails } from '@/shared/agent-chat/tools/turn-change-stats';
import { CommonModule } from '@angular/common';
import { SubagentStatusComponent } from '../activity/subagent-status.component';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ZardButtonComponent } from '@/shared/components/button';

/**
 * The band that stands in for a settled turn's work: the "Worked for X" pill,
 * the diff-stat toggle, and the agents that ran.
 *
 * Owns this markup for every surface that renders a transcript (the session
 * workspace and the embedded review/fork chats) so the two cannot drift.
 */
@Component({
  selector: 'cw-turn-summary',
  standalone: true,
  imports: [SubagentIdentityComponent, CommonModule, SubagentStatusComponent, ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './claude-turn-summary.component.html',
  styleUrl: './claude-turn-summary.component.scss',
})
export class ClaudeTurnSummaryComponent {
  readonly durationLabel = input.required<string>();
  readonly stepCount = input.required<number>();
  readonly agentSummary = input<TurnAgentSummary | null>(null);
  readonly changeDetails = input<TurnChangeDetails | null>(null);
  readonly visibleChangeDetails = computed(() => {
    const details = this.changeDetails();
    return details && details.files > 0 ? details : null;
  });
  readonly expanded = input(false);
  readonly portForwardingAttention = input(0);
  readonly changesExpanded = input(false);
  readonly canInspect = input(false);
  readonly agentsExpanded = signal(false);
  readonly activeAgents = computed(() =>
    (this.agentSummary()?.agents ?? []).filter((agent) => agent.status === 'started'),
  );
  readonly finishedCount = computed(
    () => (this.agentSummary()?.agents.length ?? 0) - this.activeAgents().length,
  );
  readonly visibleAgents = computed(() =>
    this.agentsExpanded() || this.expanded()
      ? (this.agentSummary()?.agents ?? [])
      : this.activeAgents(),
  );

  readonly toggle = output<void>();
  readonly toggleChanges = output<void>();
  readonly inspect = output<void>();
  readonly inspectAgent = output<string>();
  protected readonly agentLabel = agentLabel;
}
