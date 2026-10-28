import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import type { AgentRuntimeEvent } from '../agent-runtime/agent-runtime.types.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { NavigationEventsService } from '../navigation/navigation-events.service.js';

export interface WorkspaceSessionActivity {
  readonly id: number;
  readonly activeAgentProvider: string;
  readonly status: string;
  readonly hasUnreviewedCompletion: boolean;
  readonly lastCompletionAt: string | null;
}
type Activity = 'running' | 'attention' | 'failed' | 'queued' | 'idle';
const capacity = 2048;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function stateActivity(value: unknown): Activity {
  const state = record(value);
  if (
    state.pendingPermissionRequest ||
    state.pendingUserInputRequest ||
    state.runPhase === 'waiting' ||
    state.sessionState === 'waiting_for_input'
  )
    return 'attention';
  if (
    state.canInterrupt === true ||
    state.runPhase === 'running' ||
    state.sessionState === 'running'
  )
    return 'running';
  if (state.lastError || state.runPhase === 'error') return 'failed';
  if (Array.isArray(state.pendingPrompts) && state.pendingPrompts.length)
    return 'queued';
  return 'idle';
}

/** Scalar sidebar activity only. Never hydrates provider histories, catalogs or runtimes. */
@Injectable()
export class DesktopWorkspaceActivityService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly runtime = new Map<string, Activity>();
  private readonly hookSignatures = new Map<number, string>();
  private readonly stop: (() => void)[] = [];
  constructor(
    private readonly registry: AgentRuntimeRegistryService,
    private readonly hooks: ClaudeHooksService,
    private readonly navigation: NavigationEventsService,
  ) {}
  onModuleInit(): void {
    for (const info of this.registry.listProviders()) {
      const provider = this.registry.getProvider(info.id);
      const listener = (event: AgentRuntimeEvent) => {
        if (
          event.type !== 'run_state' &&
          event.type !== 'runtime_snapshot' &&
          event.type !== 'session_snapshot'
        )
          return;
        const key = `${info.id}:${event.payload.sessionId}`,
          next = stateActivity(event.payload),
          previous = this.runtime.get(key);
        this.runtime.delete(key);
        this.runtime.set(key, next);
        while (this.runtime.size > capacity)
          this.runtime.delete(this.runtime.keys().next().value!);
        // Token and tool updates often repeat snapshots; only semantic status changes invalidate visible pages.
        if (next !== previous) this.navigation.invalidate();
      };
      provider.on('event', listener);
      this.stop.push(() => provider.off('event', listener));
    }
    const activity = (event: { sessionId: number }) => {
      const snapshot = this.hooks.getActivity(event.sessionId);
      const signature = `${snapshot.activityStatus}:${snapshot.actionKind}:${snapshot.backgroundActive}`;
      if (this.hookSignatures.get(event.sessionId) === signature) return;
      this.hookSignatures.delete(event.sessionId);
      this.hookSignatures.set(event.sessionId, signature);
      while (this.hookSignatures.size > capacity)
        this.hookSignatures.delete(this.hookSignatures.keys().next().value!);
      this.navigation.invalidate();
    };
    this.hooks.on('status-changed', activity);
    this.stop.push(() => this.hooks.off('status-changed', activity));
  }
  onModuleDestroy(): void {
    for (const stop of this.stop) stop();
    this.stop.length = 0;
    this.runtime.clear();
    this.hookSignatures.clear();
  }
  status(session: WorkspaceSessionActivity): string {
    if (session.status === 'archived') return 'archived';
    const observed = this.runtime.get(
        `${session.activeAgentProvider}:${session.id}`,
      ),
      hooks = this.hooks.getActivity(session.id);
    if (observed === 'attention' || hooks.activityStatus === 'waiting')
      return 'attention';
    if (
      observed === 'running' ||
      hooks.activityStatus === 'running' ||
      hooks.backgroundActive
    )
      return 'running';
    if (observed === 'failed') return 'failed';
    if (observed === 'queued') return 'queued';
    if (session.hasUnreviewedCompletion) return 'review';
    if (session.lastCompletionAt || session.status === 'stopped') return 'done';
    return 'queued';
  }
}
