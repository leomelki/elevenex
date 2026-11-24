import { isWorkspacePriorityStatus } from '@elevenex/shared';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import type { AgentRuntimeEvent } from '../agent-runtime/agent-runtime.types.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { NavigationEventsService } from '../navigation/navigation-events.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { sessionAgentProvider } from '../sessions/session-provider.js';
import { DesktopDelegationActivity } from './desktop-delegation-activity.js';
import {
  inactiveSessionStatus,
  type WorkspaceSessionActivity,
} from './desktop-session-status.js';
export type { WorkspaceSessionActivity } from './desktop-session-status.js';

type Activity = 'running' | 'attention' | 'failed' | 'queued' | 'idle';
const capacity = 2048;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Detached shells and monitors. Delegated agents stay part of the agent's own work. */
function commandCount(value: unknown): number {
  const { backgroundWork } = record(value);
  return Array.isArray(backgroundWork)
    ? backgroundWork.filter((item) => record(item).kind === 'task').length
    : 0;
}
/**
 * `countCommands` keeps the legacy sidebar meaning, where a detached command
 * makes the whole session read as running. Without it, only the agent's own turn
 * and delegated agents do.
 */
function stateActivity(value: unknown, countCommands = true): Activity {
  const state = record(value);
  const background = Array.isArray(state.backgroundWork)
    ? state.backgroundWork.filter(
        (item) => countCommands || record(item).kind !== 'task',
      ).length
    : 0;
  if (
    state.pendingPermissionRequest ||
    state.pendingUserInputRequest ||
    state.runPhase === 'waiting' ||
    state.sessionState === 'requires_action' ||
    state.sessionState === 'waiting_for_input'
  )
    return 'attention';
  if (state.runPhase === 'error') return 'failed';
  if (
    state.canInterrupt === true ||
    state.runPhase === 'running' ||
    state.sessionState === 'running' ||
    state.backgroundRunActive === true ||
    background > 0
  )
    return 'running';
  if (state.lastError) return 'failed';
  if (Array.isArray(state.pendingPrompts) && state.pendingPrompts.length)
    return 'queued';
  return 'idle';
}

/** What the sidebar shows for one session. */
export interface WorkspaceSessionView {
  /** Legacy status: detached commands count as running. */
  readonly status: string;
  /** The agent's own state; present only while detached commands run. */
  readonly turnStatus?: string;
  /** Detached shell commands still running; present only when above zero. */
  readonly commandCount?: number;
}
interface ObservedActivity {
  readonly sessionId: number;
  readonly activity: Activity;
  readonly turn: Activity;
  readonly commands: number;
}

/** Scalar sidebar activity only. Never hydrates provider histories, catalogs or runtimes. */
@Injectable()
export class DesktopWorkspaceActivityService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly runtime = new Map<string, ObservedActivity>();
  private readonly hookSignatures = new Map<number, string>();
  private readonly hookActive = new Set<number>();
  readonly delegation = new DesktopDelegationActivity();
  private readonly stop: (() => void)[] = [];
  constructor(
    private readonly registry: AgentRuntimeRegistryService,
    private readonly hooks: ClaudeHooksService,
    private readonly navigation: NavigationEventsService,
    private readonly sessions: SessionsService,
  ) {}
  onModuleInit(): void {
    for (const info of this.registry.listProviders()) {
      const provider = this.registry.getProvider(info.id);
      const listener = (event: AgentRuntimeEvent) => {
        const key = `${info.id}:${event.payload.sessionId}`;
        const previous = this.runtime.get(key);
        if (
          event.type !== 'run_state' &&
          event.type !== 'runtime_snapshot' &&
          event.type !== 'session_snapshot'
        ) {
          if (previous || event.type === 'message_start') this.delegation.update(event, previous?.turn, undefined, false);
          return;
        }
        const activity = stateActivity(event.payload),
          next: ObservedActivity = {
            sessionId: event.payload.sessionId,
            activity,
            turn: stateActivity(event.payload, false),
            commands: commandCount(event.payload),
          };
        this.runtime.delete(key);
        // Idle is recoverable from persisted session metadata. Keeping idle
        // snapshots would let many quiet sessions evict genuinely live work.
        if (activity !== 'idle') this.runtime.set(key, next);
        while (this.runtime.size > capacity) {
          const [oldest] = this.runtime.keys();
          if (oldest === undefined) break;
          this.runtime.delete(oldest);
        }
        // Token and tool updates often repeat snapshots; only semantic status changes invalidate visible pages.
        const changed = (
          next.activity !== (previous?.activity ?? 'idle') ||
          next.turn !== (previous?.turn ?? 'idle') ||
          next.commands !== (previous?.commands ?? 0)
        );
        if (changed) this.navigation.invalidate();
        this.delegation.update(event, previous?.turn, next.turn, changed);
      };
      provider.on('event', listener);
      this.stop.push(() => provider.off('event', listener));
    }
    const activity = (event: { sessionId: number; provider?: string }) => {
      const snapshot = this.hooks.getActivity(event.sessionId);
      let cleared = false;
      // Hook activity is updated before run_state. Returning to idle must not
      // leave a cached spinner or input request alive after runtime teardown.
      if (snapshot.activityStatus === 'idle' && !snapshot.backgroundActive) {
        const key = `${event.provider ?? 'claude'}:${event.sessionId}`;
        const observed = this.runtime.get(key)?.activity;
        if (observed === 'running' || observed === 'attention')
          cleared = this.runtime.delete(key);
      }
      const signature = `${snapshot.activityStatus}:${snapshot.actionKind}:${snapshot.backgroundActive}:${snapshot.failed === true}`;
      if (this.hookSignatures.get(event.sessionId) === signature && !cleared)
        return;
      this.hookSignatures.delete(event.sessionId);
      this.hookSignatures.set(event.sessionId, signature);
      if (snapshot.activityStatus !== 'idle' || snapshot.backgroundActive || snapshot.failed)
        this.hookActive.add(event.sessionId);
      else this.hookActive.delete(event.sessionId);
      while (this.hookSignatures.size > capacity) {
        const [oldest] = this.hookSignatures.keys();
        if (oldest === undefined) break;
        this.hookSignatures.delete(oldest);
        this.hookActive.delete(oldest);
      }
      this.navigation.invalidate();
      this.delegation.change(event.sessionId);
    };
    this.hooks.on('status-changed', activity);
    this.stop.push(() => this.hooks.off('status-changed', activity));
    const lifecycle = (event: { sessionId: number; status: string }) => {
      if (event.status !== 'stopped' && event.status !== 'archived') return;
      for (const info of this.registry.listProviders())
        this.runtime.delete(`${info.id}:${event.sessionId}`);
      this.hookSignatures.delete(event.sessionId);
      this.hookActive.delete(event.sessionId);
      if (event.status === 'archived') this.delegation.forget(event.sessionId);
    };
    this.sessions.on('session-status-changed', lifecycle);
    this.stop.push(() =>
      this.sessions.off('session-status-changed', lifecycle),
    );
    const interrupted = (event: { sessionId: number }) => this.delegation.interrupted(event.sessionId);
    this.sessions.on('session-turn-interrupted', interrupted);
    this.stop.push(() => this.sessions.off('session-turn-interrupted', interrupted));
  }
  onModuleDestroy(): void {
    for (const stop of this.stop) stop();
    this.stop.length = 0;
    this.runtime.clear();
    this.hookSignatures.clear();
    this.hookActive.clear();
    this.delegation.dispose();
  }
  transientIds(): readonly number[] {
    return [...new Set([...this.hookActive, ...[...this.runtime.values()].map(entry => entry.sessionId)])];
  }

  /** Candidate IDs only. The persisted row and provider determine the final status. */
  priorityCandidateIds(): readonly number[] {
    const ids = new Set(this.hookActive);
    for (const entry of this.runtime.values()) {
      if (isWorkspacePriorityStatus(entry.turn)) ids.add(entry.sessionId);
    }
    return [...ids];
  }

  turnStatus(session: WorkspaceSessionActivity): string {
    return this.resolve(session, false);
  }
  status(session: WorkspaceSessionActivity): string {
    return this.resolve(session, true);
  }
  /** Legacy status plus the additive fields newer desktops use to separate commands. */
  view(session: WorkspaceSessionActivity): WorkspaceSessionView {
    const status = this.resolve(session, true);
    if (session.status === 'archived' || session.status === 'stopped')
      return { status };
    const commands =
      this.runtime.get(`${sessionAgentProvider(session)}:${session.id}`)
        ?.commands ?? 0;
    return commands > 0
      ? {
          status,
          turnStatus: this.resolve(session, false),
          commandCount: commands,
        }
      : { status };
  }
  private resolve(
    session: WorkspaceSessionActivity,
    countCommands: boolean,
  ): string {
    if (session.status === 'archived' || session.status === 'stopped')
      return inactiveSessionStatus(session);
    const entry = this.runtime.get(
        `${sessionAgentProvider(session)}:${session.id}`,
      ),
      observed = countCommands ? entry?.activity : entry?.turn,
      hooks = this.hooks.getActivity(session.id);
    // Hook background flags cannot tell commands from agents. When the runtime
    // reported its own work, that report is the authority.
    const hookBackground =
      hooks.backgroundActive && (countCommands || entry === undefined);
    if (observed === 'attention' || hooks.activityStatus === 'waiting')
      return 'attention';
    if (observed === 'failed' || hooks.failed) return 'failed';
    if (
      observed === 'running' ||
      hooks.activityStatus === 'running' ||
      hookBackground
    )
      return 'running';
    if (observed === 'queued') return 'queued';
    return inactiveSessionStatus(session);
  }
}
