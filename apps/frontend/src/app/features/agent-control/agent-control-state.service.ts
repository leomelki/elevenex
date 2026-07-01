import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { Subscription, firstValueFrom } from 'rxjs';

import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { AgentMissionsApiService } from './agent-missions-api.service';
import { NavigationService } from '@/shared/services/navigation.service';
import { TabService } from '@/features/session/tab-service';
import {
  AgentAutonomyMode,
  AgentMissionStep,
  AgentMissionStepStatus,
  DEFAULT_AGENT_AUTONOMY_MODE,
  MissionSummary,
} from './agent-control.model';

/** Raw TodoWrite todo shape as it arrives in a tool_use item's input. */
interface RawTodo {
  content?: string;
  status?: string;
  activeForm?: string;
}

/**
 * Real mission control state. A mission IS a hidden `surface:'agent'` session;
 * this service is a thin reactive layer over the backend missions API plus the
 * shared agent-runtime WebSocket. It does NOT re-implement transcript rendering
 * — the drawer embeds `app-claude-workspace` for the selected mission's live
 * view. Here we only track the mission list, the selection, and a derived step
 * tree from the agent's real TodoWrite plan.
 */
@Injectable({ providedIn: 'root' })
export class AgentControlStateService {
  // Resolve HTTP/WS-backed services lazily so this service stays constructible in
  // injectors that don't provide HttpClient (e.g. component specs that only need
  // the drawer's open/close state). They are only created on first real use.
  private readonly injector = inject(Injector);
  private get missionsApi(): AgentMissionsApiService {
    return this.injector.get(AgentMissionsApiService);
  }
  private get runtimeWs(): AgentRuntimeWebsocketService {
    return this.injector.get(AgentRuntimeWebsocketService);
  }
  private get runtimeApi(): AgentRuntimeApiService {
    return this.injector.get(AgentRuntimeApiService);
  }
  private get navService(): NavigationService {
    return this.injector.get(NavigationService);
  }
  private get tabService(): TabService {
    return this.injector.get(TabService);
  }

  /** Tools that mutate the navigation tree (sessions, workspaces, repos, projects). */
  private static readonly SIDEBAR_TOOLS = new Set([
    'create_session',
    'create_worktree',
    'add_repo',
    'remove_repo',
    'find_or_create_project',
    'delete_project',
    'link_worktree',
    'steal_worktree',
    'switch_branch',
  ]);

  private readonly openSignal = signal(false);
  private readonly missionsSignal = signal<MissionSummary[]>([]);
  private readonly selectedMissionIdSignal = signal<number | null>(null);
  private readonly loadingSignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);
  /** Default autonomy for the NEW-mission composer. */
  private readonly draftAutonomySignal = signal<AgentAutonomyMode>(
    DEFAULT_AGENT_AUTONOMY_MODE,
  );
  /** Step tree for the selected mission, derived from its latest TodoWrite. */
  private readonly selectedStepsSignal = signal<AgentMissionStep[]>([]);

  /** Live WS subscription for the selected mission (todos + status). */
  private liveSub: Subscription | null = null;
  private liveSessionId: number | null = null;

  readonly isOpen = this.openSignal.asReadonly();
  readonly missions = this.missionsSignal.asReadonly();
  readonly selectedMissionId = this.selectedMissionIdSignal.asReadonly();
  readonly loading = this.loadingSignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();
  readonly draftAutonomy = this.draftAutonomySignal.asReadonly();
  readonly selectedSteps = this.selectedStepsSignal.asReadonly();

  readonly selectedMission = computed(() => {
    const id = this.selectedMissionIdSignal();
    return this.missionsSignal().find((m) => m.sessionId === id) ?? null;
  });

  readonly activeMissionsCount = computed(
    () =>
      this.missionsSignal().filter(
        (m) => m.status !== 'archived' && m.runPhase !== 'error',
      ).length,
  );

  /**
   * The code session currently open in the tab bar, if any. Exposed so the
   * command bar can show a small session chip indicating what will be attached
   * to the next message.
   */
  readonly contextTab = computed(() => this.tabService.activeTab());

  // --- Drawer open/close (preserved external API; the panel is global) -------

  open(): void {
    this.openSignal.set(true);
    void this.refresh();
  }

  openGlobal(): void {
    this.open();
  }

  openProject(_project: { id: number; name: string }): void {
    this.open();
  }

  openSession(_context: { sessionId: number }): void {
    this.open();
  }

  close(): void {
    this.openSignal.set(false);
  }

  /** Toggle the drawer; opening refreshes the mission list (via `open`). */
  toggle(): void {
    if (this.openSignal()) {
      this.close();
    } else {
      this.open();
    }
  }

  // --- Mission list ----------------------------------------------------------

  /** Reload the mission list from the backend. */
  async refresh(): Promise<void> {
    this.loadingSignal.set(true);
    this.errorSignal.set(null);
    try {
      const missions = await firstValueFrom(this.missionsApi.list());
      this.missionsSignal.set(missions);
      // If the currently selected mission is no longer in the list, clear it.
      const current = this.selectedMissionIdSignal();
      if (current && !missions.some((m) => m.sessionId === current)) {
        this.select(null);
      }
    } catch {
      this.errorSignal.set('Could not load missions.');
    } finally {
      this.loadingSignal.set(false);
    }
  }

  /** Clear the active mission selection without affecting the mission list. */
  clearSelection(): void {
    this.select(null);
  }

  /** Create + start a mission, then select it. Returns its session id. */
  async createMission(
    prompt: string,
    autonomyMode: AgentAutonomyMode = this.draftAutonomySignal(),
  ): Promise<number | null> {
    const clean = prompt.trim();
    if (!clean) {
      return null;
    }
    this.errorSignal.set(null);
    try {
      // Report the open session out-of-band (not in the prompt). The agent pulls
      // it on demand via get_focused_session only when the user's words imply
      // the currently-open session, so a follow-up never mis-attributes to it.
      const mission = await firstValueFrom(
        this.missionsApi.create({
          prompt: clean,
          autonomyMode,
          focusedSessionId: this.tabService.activeTab()?.sessionId,
        }),
      );
      this.openSignal.set(true);
      // Optimistically add the new mission so the selection is immediate without
      // waiting for a round-trip refresh. A background refresh follows to sync
      // any server-side changes (e.g. runPhase updates).
      this.missionsSignal.update((ms) => [mission, ...ms.filter((m) => m.sessionId !== mission.sessionId)]);
      this.select(mission.sessionId);
      void this.refresh();
      return mission.sessionId;
    } catch {
      this.errorSignal.set('Could not start the mission.');
      return null;
    }
  }

  selectMission(sessionId: number): void {
    this.select(sessionId);
  }

  setDraftAutonomy(mode: AgentAutonomyMode): void {
    this.draftAutonomySignal.set(mode);
  }

  /** Change a mission's autonomy mandate (persisted + applied to the runtime). */
  async setMissionAutonomy(
    sessionId: number,
    mode: AgentAutonomyMode,
  ): Promise<void> {
    const updated = await firstValueFrom(
      this.missionsApi.setAutonomy(sessionId, mode),
    );
    this.patchMission(updated);
  }

  async interruptMission(sessionId: number): Promise<void> {
    await firstValueFrom(this.missionsApi.interrupt(sessionId));
  }

  async archiveMission(sessionId: number): Promise<void> {
    await firstValueFrom(this.missionsApi.archive(sessionId));
    if (this.selectedMissionIdSignal() === sessionId) {
      this.select(null);
    }
    await this.refresh();
  }

  // --- Selection + live derivation ------------------------------------------

  private select(sessionId: number | null): void {
    if (this.selectedMissionIdSignal() === sessionId) {
      return;
    }
    this.selectedMissionIdSignal.set(sessionId);
    this.selectedStepsSignal.set([]);
    this.teardownLive();
    if (sessionId != null) {
      this.setupLive(sessionId);
    }
  }

  /**
   * Subscribe to the selected mission's runtime stream to keep the step tree and
   * row status live. Seeds the step tree from history (HTTP) so a freshly
   * selected mission shows its current plan immediately.
   */
  private setupLive(sessionId: number): void {
    this.liveSessionId = sessionId;

    void firstValueFrom(this.runtimeApi.getHistory(sessionId, 'claude'))
      .then((history) => {
        if (this.liveSessionId === sessionId) {
          this.deriveStepsFromHistory(history);
        }
      })
      .catch(() => {
        /* No history yet — the WS stream will fill it in. */
      });

    this.liveSub = this.runtimeWs.connect(sessionId, 'claude').subscribe({
      next: (event) => this.handleRuntimeEvent(sessionId, event),
    });
  }

  private teardownLive(): void {
    this.liveSub?.unsubscribe();
    this.liveSub = null;
    this.liveSessionId = null;
  }

  private handleRuntimeEvent(
    sessionId: number,
    event: { type: string; payload?: Record<string, unknown> },
  ): void {
    const payload = event.payload ?? {};
    if (event.type === 'run_state') {
      const runPhase = (payload['runPhase'] as string | undefined) ?? null;
      const awaitingApproval =
        Boolean(payload['pendingPermissionRequest']) ||
        Boolean(payload['pendingUserInputRequest']);
      this.updateMissionLiveStatus(sessionId, runPhase, awaitingApproval);
      return;
    }
    if (event.type === 'tool_use' || event.type === 'tool_result') {
      const item = payload['item'] as AgentTranscriptItem | undefined;
      if (item && this.isTodoWrite(item)) {
        this.deriveSteps(this.readTodos(item));
      }
      if (event.type === 'tool_result' && item) {
        const name = item.toolName ?? item.providerToolName ?? '';
        if (AgentControlStateService.SIDEBAR_TOOLS.has(name)) {
          this.navService.refreshTree();
        }
      }
    }
  }

  private updateMissionLiveStatus(
    sessionId: number,
    runPhase: string | null,
    awaitingApproval: boolean,
  ): void {
    this.missionsSignal.update((missions) =>
      missions.map((m) =>
        m.sessionId === sessionId ? { ...m, runPhase, awaitingApproval } : m,
      ),
    );
  }

  private patchMission(updated: MissionSummary): void {
    this.missionsSignal.update((missions) =>
      missions.map((m) => (m.sessionId === updated.sessionId ? updated : m)),
    );
  }

  private deriveStepsFromHistory(history: AgentTranscriptItem[]): void {
    // The latest TodoWrite in the transcript is the current plan.
    const latest = [...history].reverse().find((item) => this.isTodoWrite(item));
    if (latest) {
      this.deriveSteps(this.readTodos(latest));
    }
  }

  private isTodoWrite(item: AgentTranscriptItem): boolean {
    return (
      item.kind === 'tool_use' &&
      (item.toolName === 'TodoWrite' || item.providerToolName === 'TodoWrite')
    );
  }

  private readTodos(item: AgentTranscriptItem): RawTodo[] {
    const input = (item.toolInput ?? item.providerToolInput) as
      | { todos?: RawTodo[] }
      | undefined;
    return Array.isArray(input?.todos) ? input.todos : [];
  }

  private deriveSteps(todos: RawTodo[]): void {
    const steps: AgentMissionStep[] = todos.map((todo, index) => ({
      id: `step-${index}`,
      kind: 'action',
      label:
        (todo.status === 'in_progress' && todo.activeForm
          ? todo.activeForm
          : todo.content) ?? 'Step',
      status: this.todoStatus(todo.status),
      targetSummary: '',
    }));
    this.selectedStepsSignal.set(steps);
  }

  private todoStatus(status: string | undefined): AgentMissionStepStatus {
    switch (status) {
      case 'completed':
        return 'complete';
      case 'in_progress':
        return 'active';
      default:
        return 'pending';
    }
  }
}
