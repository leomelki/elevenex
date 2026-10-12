import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { AgentSubagentState } from '@/shared/models/agent-runtime.model';

type Status = Pick<AgentSubagentState, 'status' | 'executionStatus' | 'stoppedByUser'>;
export function agentStatusLabel(agent: Status): string {
  if (agent.stoppedByUser && agent.status === 'started') return 'Stopping';
  const labels = {
    pending: 'Starting',
    running: 'Running',
    waiting: 'Needs approval',
    paused: 'Paused',
    completed: 'Completed',
    interrupted: 'Stopped',
    error: 'Failed',
    closed: 'Closed',
    unavailable: 'Unavailable',
  };
  return agent.executionStatus
    ? labels[agent.executionStatus]
    : agent.status === 'stopped'
      ? 'Status unavailable'
      : 'Running';
}
export function agentLabel(agent: Pick<AgentSubagentState, 'agentType' | 'displayName'>): string {
  return (
    agent.displayName ??
    agent.agentType.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

@Component({
  selector: 'cw-subagent-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0' },
  template: `<span
    class="inline-flex items-center gap-1.5 text-[0.6875rem] font-medium"
    [class]="tone()"
  >
    <span
      class="size-1.5 rounded-full bg-current motion-reduce:animate-none"
      [class.animate-pulse]="
        agent().status === 'started' &&
        (!agent().executionStatus || agent().executionStatus === 'running')
      "
    ></span
    >{{ label() }}
  </span>`,
})
export class SubagentStatusComponent {
  readonly agent = input.required<Status>();
  readonly label = computed(() => agentStatusLabel(this.agent()));
  readonly tone = computed(() => {
    const state = this.agent().executionStatus;
    if (state === 'error') return 'text-destructive';
    if (state === 'waiting' || state === 'paused' || state === 'interrupted' || state === 'pending')
      return 'text-warning';
    if (
      state === 'closed' ||
      state === 'unavailable' ||
      (!state && this.agent().status === 'stopped')
    )
      return 'text-muted-foreground';
    return 'text-success';
  });
}
