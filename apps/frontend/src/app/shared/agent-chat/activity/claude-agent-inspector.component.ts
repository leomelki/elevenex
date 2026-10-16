import { agentLabel } from '@/shared/agent-tools/agent-label';
import { SubagentIdentityComponent } from '@/shared/agent-chat/activity/subagent-identity.component';
import { BreakpointObserver } from '@angular/cdk/layout';
import { toSignal } from '@angular/core/rxjs-interop';
import { ClaudePermissionInlineComponent } from '../requests/claude-permission-inline.component';
import type {
  AgentPermissionRequest,
  AgentPermissionApproval,
} from '@/shared/models/agent-runtime.model';
import {
  AgentTimelineEntry,
  TurnAgentRun,
  TurnAgentSummary,
  buildAgentTimelineEntries,
  formatTimestamp,
  humanizeAgentType,
} from '@/shared/agent-chat/activity/agent-deep-dive';
import { ClaudeToolCallComponent } from '@/shared/agent-chat/tools/claude-tool-call.component';
import { ClaudeTranscriptComponent } from '@/shared/agent-chat/transcript/claude-transcript.component';
import { TranscriptViewportDirective } from '@/shared/agent-chat/transcript/transcript-viewport.directive';
import {
  buildTranscriptRenderItems,
  TurnChangeCache,
} from '@/shared/agent-chat/transcript/transcript-render-items';
import { pairTranscript } from '@/shared/agent-chat/transcript/paired-transcript';
import { copyChatMessage } from '@/shared/agent-chat/transcript/message-clipboard';
import type { TranscriptToolState } from '@/shared/agent-chat/transcript/transcript-view-state';
import {
  AgentHookEvent,
  AgentSubagentHistoryPayload,
  AgentTranscriptItem,
  AgentProviderId,
} from '@/shared/models/agent-runtime.model';
import { CommonModule } from '@angular/common';
import { A11yModule } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  inject,
  output,
  signal,
} from '@angular/core';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { ZardSkeletonComponent } from '@/shared/components/skeleton';
import { AgentMarkdownComponent } from '../markdown/agent-markdown.component';
import { SubagentStatusComponent } from './subagent-status.component';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';
import { buildSubagentIndex } from '@/shared/agent-tools/agent-collaboration-format';
import { ContextUsageComponent } from '../context-usage/context-usage.component';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX, lucideRefreshCw, lucideSearch } from '@ng-icons/lucide';

export interface ClaudeSubagentHistoryState {
  loading: boolean;
  data: AgentSubagentHistoryPayload | null;
  error: string | null;
}

function agentGroup(agent: TurnAgentRun): 'active' | 'completed' | 'inactive' {
  if (agent.status === 'started') return 'active';
  return agent.executionStatus === 'completed' ? 'completed' : 'inactive';
}

@Component({
  selector: 'cw-agent-inspector',
  standalone: true,
  imports: [
    SubagentIdentityComponent,
    CommonModule,
    ClaudePermissionInlineComponent,
    NgIcon,
    ClaudeToolCallComponent,
    ClaudeTranscriptComponent,
    TranscriptViewportDirective,
    A11yModule,
    ZardButtonComponent,
    ZardInputDirective,
    ZardSkeletonComponent,
    SubagentStatusComponent,
    ContextUsageComponent,
    AgentMarkdownComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideX,
      lucideRefreshCw,
      lucideSearch,
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
  readonly liveItems = input<readonly AgentTranscriptItem[]>([]);
  readonly toolProgress = input<TranscriptToolState['progress']>({});
  readonly worktreePath = input<string | null>(null);
  readonly provider = input<AgentProviderId>('claude');

  readonly readOnly = input(false);
  readonly busyActions = input<Record<string, 'stopping' | 'backgrounding'>>({});
  readonly pendingPermission = input<AgentPermissionRequest | null>(null);
  readonly stopAgent = output<string>();
  readonly backgroundAgent = output<string>();
  readonly followUpAgent = output<string>();
  readonly loadEarlier = output<string>();
  readonly approve = output<AgentPermissionApproval>();
  readonly deny = output<string | undefined>();
  readonly wide = toSignal(inject(BreakpointObserver).observe('(min-width: 1100px)'), {
    initialValue: { matches: true, breakpoints: {} },
  });
  readonly close = output<void>();
  readonly selectAgent = output<string>();
  readonly refreshAgent = output<string>();
  readonly openLocalFile = output<LocalFileTarget>();

  readonly tab = signal<'timeline' | 'transcript' | 'hooks'>('transcript');
  readonly scrollMemory = new Map<string, { top: number; pinned: boolean }>();
  readonly expandedTurns = signal<Record<string, boolean>>({});
  readonly expandedChanges = signal<Record<string, boolean>>({});
  readonly turnExpansion = computed(() => ({
    turns: this.expandedTurns(),
    changes: this.expandedChanges(),
  }));
  readonly copyMessage = copyChatMessage;
  private readonly turnChangeCache = new TurnChangeCache();
  readonly search = signal('');
  readonly filter = signal<'all' | 'active' | 'attention'>('all');
  readonly counts = computed(() => {
    const agents = this.turn()?.agents ?? [];
    return {
      total: agents.length,
      active: agents.filter((agent) => agent.status === 'started').length,
      attention: agents.filter((agent) =>
        ['error', 'interrupted', 'waiting', 'paused', 'unavailable'].includes(
          agent.executionStatus ?? '',
        ),
      ).length,
    };
  });
  readonly visibleAgents = computed(() => {
    const agents = this.turn()?.agents ?? [];
    const byParent = new Map<string | undefined, TurnAgentRun[]>();
    const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
    for (const agent of agents) {
      const parentAgent = agent.parentAgentId ? byId.get(agent.parentAgentId) : undefined;
      // Keep nesting within a status section; a finished parent must not bury a live child.
      const parent =
        parentAgent && agentGroup(parentAgent) === agentGroup(agent)
          ? parentAgent.agentId
          : undefined;
      const siblings = byParent.get(parent) ?? [];
      siblings.push(agent);
      byParent.set(parent, siblings);
    }
    // Keep launch order stable within each section as usage notifications arrive.
    for (const siblings of byParent.values())
      siblings.sort(
        (a, b) =>
          (a.startedAt ?? a.lastEventAt).localeCompare(b.startedAt ?? b.lastEventAt) ||
          a.agentId.localeCompare(b.agentId),
      );
    const ordered: { agent: TurnAgentRun; depth: number }[] = [];
    const seen = new Set<string>();
    const visit = (agent: TurnAgentRun, depth: number) => {
      if (seen.has(agent.agentId)) return;
      seen.add(agent.agentId);
      ordered.push({ agent, depth });
      for (const child of byParent.get(agent.agentId) ?? []) visit(child, depth + 1);
    };
    for (const agent of byParent.get(undefined) ?? []) visit(agent, 0);
    for (const agent of agents) if (!seen.has(agent.agentId)) visit(agent, 0);
    const search = this.search().trim().toLowerCase();
    const filter = this.filter();
    const filtered = ordered.filter(
      ({ agent }) =>
        (!search ||
          [
            agentLabel(agent),
            agent.displayName,
            agent.agentPath,
            agent.agentType,
            agent.prompt,
            agent.summary,
            agent.agentId,
          ].some((value) => value?.toLowerCase().includes(search))) &&
        (filter === 'all' ||
          (filter === 'active'
            ? agent.status === 'started'
            : ['error', 'interrupted', 'waiting', 'paused', 'unavailable'].includes(
                agent.executionStatus ?? '',
              ))),
    );
    return ['active', 'completed', 'inactive'].flatMap((group) =>
      filtered.filter(({ agent }) => agentGroup(agent) === group),
    );
  });
  readonly agentGroups = computed(() => {
    const rows = this.visibleAgents();
    return [
      { id: 'active', label: 'Running' },
      { id: 'completed', label: 'Completed' },
      { id: 'inactive', label: 'Not running' },
    ]
      .map((group) => ({
        ...group,
        rows: rows.filter(({ agent }) => agentGroup(agent) === group.id),
      }))
      .filter((group) => group.rows.length);
  });

  readonly selectedAgent = computed<TurnAgentRun | null>(() => {
    const turn = this.turn();
    const selectedId = this.selectedAgentId();
    if (!turn || !selectedId) return null;
    const run = turn.agents.find((agent) => agent.agentId === selectedId);
    if (!run) return null;
    const data = this.historyByAgent()[selectedId]?.data?.subagent;
    if (!data) return run;
    return {
      ...run,
      displayName: data.displayName ?? run.displayName,
      taskId: run.taskId ?? data.taskId,
      canStop: run.canStop ?? data.canStop,
      canBackground: run.canBackground ?? data.canBackground,
      canFollowUp: run.canFollowUp ?? data.canFollowUp,
      stoppedByUser: run.stoppedByUser ?? data.stoppedByUser,
      worktreePath: data.worktreePath ?? run.worktreePath,
      usage: run.usage ?? data.usage,
      isBackgrounded: run.isBackgrounded ?? data.isBackgrounded,
      lastToolName: run.lastToolName ?? data.lastToolName,
      agentType: data.agentType,
      prompt: data.prompt ?? run.prompt,
      model: data.model ?? run.model,
      reasoningEffort: data.reasoningEffort ?? run.reasoningEffort,
      ...(data.contextUsageUpdatedAt &&
      (!run.contextUsageUpdatedAt || data.contextUsageUpdatedAt > run.contextUsageUpdatedAt)
        ? { contextUsage: data.contextUsage, contextUsageUpdatedAt: data.contextUsageUpdatedAt }
        : {}),
      ...(data.timestamp >= run.lastEventAt
        ? {
            status: data.status,
            executionStatus: data.executionStatus,
            lastEventAt: data.timestamp,
            summary: data.lastAssistantMessage ?? run.summary,
          }
        : {}),
    };
  });

  readonly selectedHistoryState = computed<ClaudeSubagentHistoryState | null>(() => {
    const selectedId = this.selectedAgentId();
    return selectedId ? (this.historyByAgent()[selectedId] ?? null) : null;
  });

  readonly timelineEntries = computed<AgentTimelineEntry[]>(() =>
    buildAgentTimelineEntries(this.selectedHistoryState()?.data ?? null, this.selectedAgent()),
  );

  private readonly selectedLive = computed(
    () => {
      const agent = this.selectedAgent();
      if (!agent) return [];
      return this.liveItems().filter(
        (item) =>
          item.agentId === agent.agentId ||
          (!item.agentId &&
            agent.parentToolUseId &&
            item.parentToolUseId === agent.parentToolUseId),
      );
    },
    { equal: (a, b) => a.length === b.length && a.every((item, index) => item === b[index]) },
  );

  readonly chatHistory = computed<AgentTranscriptItem[]>(() => {
    const agent = this.selectedAgent();
    const saved = this.selectedHistoryState()?.data?.history ?? [];
    const byId = new Map(saved.map((item) => [item.id, item]));
    for (const item of this.selectedLive())
      byId.set(item.id, {
        ...item,
        parentToolUseId:
          item.parentToolUseId === agent?.parentToolUseId ||
          item.parentToolUseId === `claude-agent:${agent?.agentId}`
            ? undefined
            : item.parentToolUseId,
      });
    const history = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const prompt = agent?.prompt?.trim();
    // A known assignment should use the same user-message presentation as normal chat.
    if (
      !agent ||
      !prompt ||
      history.some((item) => item.kind === 'user' && item.content?.trim() === prompt)
    )
      return history;
    return [
      {
        id: `assignment-${agent.agentId}`,
        kind: 'user',
        content: prompt,
        timestamp: agent.startedAt ?? history[0]?.timestamp ?? agent.lastEventAt,
      },
      ...history,
    ];
  });
  readonly chatChildren = computed(() => {
    const children: Record<string, AgentTranscriptItem[]> = {};
    for (const item of this.chatHistory())
      if (item.parentToolUseId) (children[item.parentToolUseId] ??= []).push(item);
    return children;
  });
  readonly chatUnits = computed(() =>
    pairTranscript(this.chatHistory().filter((item) => !item.parentToolUseId)),
  );
  readonly chatItems = computed(() =>
    buildTranscriptRenderItems(
      {
        units: this.chatUnits(),
        settled: this.selectedAgent()?.status !== 'started',
        childItemsByParentToolUseId: this.chatChildren(),
        subagents: (this.turn()?.agents ?? []).map((agent) => ({
          ...agent,
          timestamp: agent.lastEventAt,
        })),
        hookEvents: this.hookEvents(),
      },
      this.turnChangeCache,
    ),
  );
  readonly chatTools = computed<TranscriptToolState>(() => ({
    children: this.chatChildren(),
    agents: this.agentIndex(),
    progress: this.toolProgress(),
    liveIds: new Set(
      this.selectedAgent()?.status === 'started'
        ? this.chatUnits().flatMap((unit) =>
            unit.kind === 'tool' && !unit.result ? [unit.toolUseId] : [],
          )
        : [],
    ),
  }));

  toggleTurn(id: string): void {
    this.expandedTurns.update((turns) => ({ ...turns, [id]: !turns[id] }));
  }
  toggleChanges(id: string): void {
    this.expandedChanges.update((changes) => ({ ...changes, [id]: !changes[id] }));
  }
  closeChanges(id: string): void {
    this.expandedChanges.update((changes) => ({ ...changes, [id]: false }));
  }
  readonly agentIndex = computed(() =>
    buildSubagentIndex(
      (this.turn()?.agents ?? []).map((agent) => ({
        ...agent,
        timestamp: agent.lastEventAt,
        lastAssistantMessage: agent.summary,
      })),
    ),
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
  protected readonly agentLabel = agentLabel;
  readonly parentAgent = computed(() =>
    this.turn()?.agents.find((agent) => agent.agentId === this.selectedAgent()?.parentAgentId),
  );
  private readonly refreshKey = computed(() => {
    const agent = this.selectedAgent();
    return this.open() && agent ? `${agent.agentId}|${agent.status}` : null;
  });

  constructor() {
    let previousKey: string | null = null;
    effect((onCleanup) => {
      const key = this.refreshKey();
      const previous = previousKey;
      previousKey = key;
      if (!key) return;
      const [id, status] = key.split('|');
      if (status === 'stopped' && previous === `${id}|started`) this.refreshAgent.emit(id);
      if (status !== 'started') return;
      const timer = setInterval(() => {
        if (!document.hidden) this.refreshAgent.emit(id);
      }, 2000);
      onCleanup(() => clearInterval(timer));
    });
  }

  clusterItemLabel(item: AgentTranscriptItem): string {
    if (item.kind === 'thinking') return 'Thinking';
    if (item.kind === 'system') return 'System';
    return 'Note';
  }
}
