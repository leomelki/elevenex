import type { TurnAgentSummary } from '@/shared/agent-chat/activity/agent-deep-dive';
import type { TurnChangeDetails } from '@/shared/agent-chat/tools/turn-change-stats';
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

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
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './claude-turn-summary.component.html',
  styleUrl: './claude-turn-summary.component.scss',
})
export class ClaudeTurnSummaryComponent {
  readonly durationLabel = input.required<string>();
  readonly stepCount = input.required<number>();
  readonly agentSummary = input<TurnAgentSummary | null>(null);
  readonly changeDetails = input<TurnChangeDetails | null>(null);
  readonly expanded = input(false);
  readonly changesExpanded = input(false);
  readonly canInspect = input(false);

  readonly toggle = output<void>();
  readonly toggleChanges = output<void>();
  readonly inspect = output<void>();
}
