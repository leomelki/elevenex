import {
  AgentTimelineEntry,
  TurnAgentRun,
  TurnAgentSummary,
  buildAgentTimelineEntries,
  buildAgentTranscriptUnits,
  formatTimestamp,
  humanizeAgentType,
} from '@/shared/agent-chat/activity/agent-deep-dive';
import { ClaudeToolCallComponent } from '@/shared/agent-chat/tools/claude-tool-call.component';
import { ClaudeMessageComponent } from '@/shared/agent-chat/transcript/claude-message.component';
import {
  AgentHookEvent,
  AgentSubagentHistoryPayload,
  AgentTranscriptItem,
} from '@/shared/models/agent-runtime.model';
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideActivity, lucideFileSearch, lucideScrollText, lucideX } from '@ng-icons/lucide';

export interface ClaudeSubagentHistoryState {
  loading: boolean;
  data: AgentSubagentHistoryPayload | null;
  error: string | null;
}

@Component({
  selector: 'cw-agent-inspector',
  standalone: true,
  imports: [CommonModule, NgIcon, ClaudeToolCallComponent, ClaudeMessageComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideActivity,
      lucideFileSearch,
      lucideScrollText,
      lucideX,
    }),
  ],
  templateUrl: './claude-agent-inspector.component.html',
  styleUrl: './claude-agent-inspector.component.scss',
})
export class ClaudeAgentInspectorComponent {
  readonly open = input<boolean>(false);
  readonly turn = input<TurnAgentSummary | null>(null);
  readonly selectedAgentId = input<string | null>(null);
  readonly historyByAgent = input<Record<string, ClaudeSubagentHistoryState>>({});
  readonly hookEvents = input<AgentHookEvent[]>([]);

  readonly close = output<void>();
  readonly selectAgent = output<string>();

  readonly tab = signal<'timeline' | 'transcript' | 'hooks'>('timeline');

  readonly selectedAgent = computed<TurnAgentRun | null>(() => {
    const turn = this.turn();
    const selectedId = this.selectedAgentId();
    if (!turn || !selectedId) return null;
    return turn.agents.find((agent) => agent.agentId === selectedId) ?? null;
  });

  readonly selectedHistoryState = computed<ClaudeSubagentHistoryState | null>(() => {
    const selectedId = this.selectedAgentId();
    return selectedId ? (this.historyByAgent()[selectedId] ?? null) : null;
  });

  readonly timelineEntries = computed<AgentTimelineEntry[]>(() =>
    buildAgentTimelineEntries(this.selectedHistoryState()?.data ?? null, this.selectedAgent()),
  );

  readonly transcriptUnits = computed(() =>
    buildAgentTranscriptUnits(this.selectedHistoryState()?.data ?? null),
  );

  readonly hookEventsForSelectedAgent = computed(() => {
    const agent = this.selectedAgent();
    const turn = this.turn();
    if (!agent || !turn) return [];
    return this.hookEvents().filter(
      (event) =>
        event.agentId === agent.agentId &&
        new Date(event.timestamp).getTime() >= new Date(turn.startedAt).getTime() &&
        new Date(event.timestamp).getTime() <= new Date(turn.completedAt).getTime(),
    );
  });

  protected readonly humanizeAgentType = humanizeAgentType;
  protected readonly formatTimestamp = formatTimestamp;

  clusterItemLabel(item: AgentTranscriptItem): string {
    if (item.kind === 'thinking') return 'Thinking';
    if (item.kind === 'system') return 'System';
    return 'Note';
  }
}
