import { Injectable, computed, signal } from '@angular/core';
import {
  AGENT_CONTROL_GLOBAL_CONTEXT,
  AgentApprovalDecision,
  AgentAutonomyMode,
  AgentControlContext,
  AgentDeepLinkTarget,
  AgentMission,
  AgentMissionApproval,
  AgentMissionArtifact,
  AgentMissionKind,
  AgentMissionMessage,
  AgentMissionStatus,
  AgentMissionStep,
  DEFAULT_AGENT_AUTONOMY_MODE,
} from './agent-control.model';

interface PersistedAgentControlState {
  context?: AgentControlContext;
  selectedMissionId?: string | null;
  missions?: AgentMission[];
  sequence?: number;
  autonomyMode?: AgentAutonomyMode;
}

const STORAGE_KEY = 'elevenex-agent-control-state';

const missionKindLabels: Record<AgentMissionKind, string> = {
  create_project: 'Create project',
  create_worktree: 'Create worktree',
  run_agent: 'Run agent',
  review_work: 'Review work',
};

@Injectable({ providedIn: 'root' })
export class AgentControlStateService {
  private readonly initialState = this.loadState();
  private readonly openSignal = signal(false);
  private readonly contextSignal = signal<AgentControlContext>(AGENT_CONTROL_GLOBAL_CONTEXT);
  private readonly missionsSignal = signal<AgentMission[]>(this.initialState.missions ?? []);
  private readonly selectedMissionIdSignal = signal<string | null>(
    this.resolveInitialSelectedMissionId(),
  );
  private readonly sequenceSignal = signal(this.initialState.sequence ?? 0);
  private readonly autonomyModeSignal = signal<AgentAutonomyMode>(
    this.initialState.autonomyMode ?? DEFAULT_AGENT_AUTONOMY_MODE,
  );

  readonly isOpen = this.openSignal.asReadonly();
  readonly context = this.contextSignal.asReadonly();
  readonly missions = this.missionsSignal.asReadonly();
  readonly selectedMissionId = this.selectedMissionIdSignal.asReadonly();
  readonly autonomyMode = this.autonomyModeSignal.asReadonly();
  readonly selectedMission = computed(() => {
    const id = this.selectedMissionIdSignal();
    return this.missionsSignal().find((mission) => mission.id === id) ?? null;
  });
  readonly activeMissionsCount = computed(
    () =>
      this.missionsSignal().filter(
        (mission) => mission.status !== 'complete' && mission.status !== 'blocked',
      ).length,
  );
  /** Pending approvals for the selected mission, surfaced for the escalation UI. */
  readonly pendingApprovals = computed(
    () => this.selectedMission()?.approvals.filter((approval) => approval.status === 'pending') ?? [],
  );
  /** True when the selected mission needs human attention (escalation). */
  readonly selectedMissionNeedsAttention = computed(() => {
    const mission = this.selectedMission();
    if (!mission) {
      return false;
    }
    return mission.status === 'waiting_approval' || this.pendingApprovals().length > 0;
  });

  open(_context: AgentControlContext = AGENT_CONTROL_GLOBAL_CONTEXT): void {
    this.contextSignal.set(AGENT_CONTROL_GLOBAL_CONTEXT);
    this.openSignal.set(true);
    this.persist();
  }

  openGlobal(): void {
    this.open(AGENT_CONTROL_GLOBAL_CONTEXT);
  }

  openProject(project: { id: number; name: string }): void {
    void project;
    this.openGlobal();
  }

  openSession(context: {
    projectId: number;
    repoId: number;
    sessionId: number;
    sessionName: string;
    worktreePath: string;
    workspaceName?: string | null;
    branchName: string;
  }): void {
    void context;
    this.openGlobal();
  }

  close(): void {
    this.openSignal.set(false);
  }

  selectMission(id: string): void {
    if (!this.missionsSignal().some((mission) => mission.id === id)) {
      return;
    }
    this.selectedMissionIdSignal.set(id);
    this.persist();
  }

  /** Set the default autonomy mode for newly created missions. */
  setAutonomyMode(mode: AgentAutonomyMode): void {
    if (this.autonomyModeSignal() === mode) {
      return;
    }
    this.autonomyModeSignal.set(mode);
    this.persist();
  }

  /** Update the autonomy mode of an existing mission. */
  setMissionAutonomyMode(missionId: string, mode: AgentAutonomyMode): void {
    this.updateMission(missionId, (mission) =>
      mission.autonomyMode === mode ? mission : { ...mission, autonomyMode: mode, updatedAt: new Date().toISOString() },
    );
  }

  createMission(prompt: string): AgentMission | null {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      return null;
    }

    const kind = this.inferMissionKind(cleanPrompt);
    const now = new Date().toISOString();
    const sequence = this.sequenceSignal() + 1;
    this.sequenceSignal.set(sequence);

    const autonomyMode = this.autonomyModeSignal();
    // In full-autonomy mode the agent proceeds without a human gate, so missions
    // begin planned rather than waiting for an approval.
    const initialStatus: AgentMissionStatus = autonomyMode === 'full' ? 'planned' : 'waiting_approval';

    const mission: AgentMission = {
      id: `mission-${sequence}`,
      title: this.titleFor(cleanPrompt, kind),
      prompt: cleanPrompt,
      status: initialStatus,
      autonomyMode,
      context: this.contextSignal(),
      steps: this.stepsFor(kind, cleanPrompt),
      approvals:
        autonomyMode === 'full'
          ? []
          : [
              {
                id: `mission-${sequence}-approval-plan`,
                label: 'Approve preview plan',
                status: 'pending',
                summary: 'No project, worktree, session, process, or file change will be made.',
                target: this.deepLinkTarget(),
              },
            ],
      artifacts: this.artifactsFor(kind),
      messages: this.messagesFor(cleanPrompt, kind, now),
      createdAt: now,
      updatedAt: now,
    };

    this.missionsSignal.update((missions) => [mission, ...missions]);
    this.selectedMissionIdSignal.set(mission.id);
    this.openSignal.set(true);
    this.persist();
    return mission;
  }

  approveMission(id: string): void {
    this.updateMission(id, (mission) =>
      mission.status === 'waiting_approval'
        ? this.withStatus(mission, 'planned', 'Preview plan approved locally.')
        : mission,
    );
  }

  runMission(id: string): void {
    this.updateMission(id, (mission) =>
      mission.status === 'planned'
        ? this.withStatus(mission, 'running', 'Preview run started locally.')
        : mission,
    );
  }

  reviewMission(id: string): void {
    this.updateMission(id, (mission) =>
      mission.status === 'running'
        ? this.withStatus(mission, 'review', 'Preview run moved into review.')
        : mission,
    );
  }

  completeMission(id: string): void {
    this.updateMission(id, (mission) =>
      mission.status === 'review'
        ? this.withStatus(mission, 'complete', 'Preview mission marked complete.')
        : mission,
    );
  }

  /**
   * Resolve a single escalation/approval on a mission. Approving the last
   * pending approval advances the mission out of `waiting_approval`; declining
   * blocks the mission so the human stays in control.
   */
  resolveApproval(missionId: string, approvalId: string, decision: AgentApprovalDecision): void {
    this.updateMission(missionId, (mission) => {
      const target = mission.approvals.find((approval) => approval.id === approvalId);
      if (!target || target.status !== 'pending') {
        return mission;
      }

      const now = new Date().toISOString();
      const approvals: AgentMissionApproval[] = mission.approvals.map((approval) =>
        approval.id === approvalId
          ? { ...approval, status: decision === 'approve' ? 'approved' : 'skipped' }
          : approval,
      );

      const stillPending = approvals.some((approval) => approval.status === 'pending');

      let status: AgentMissionStatus = mission.status;
      let message: string;
      if (decision === 'decline') {
        status = 'blocked';
        message = `Declined "${target.label}". Mission blocked pending your direction.`;
      } else if (!stillPending && mission.status === 'waiting_approval') {
        status = 'planned';
        message = `Approved "${target.label}". Plan ready to run.`;
      } else {
        message = `Approved "${target.label}".`;
      }

      return {
        ...mission,
        status,
        approvals,
        steps: this.stepsForStatus(mission.steps, status),
        messages: [
          ...mission.messages,
          {
            id: `${mission.id}-approval-${approvalId}-${mission.messages.length + 1}`,
            role: 'system',
            content: message,
            createdAt: now,
          },
        ],
        updatedAt: now,
      };
    });
  }

  reset(): void {
    this.missionsSignal.set([]);
    this.selectedMissionIdSignal.set(null);
    this.sequenceSignal.set(0);
    this.persist();
  }

  private resolveInitialSelectedMissionId(): string | null {
    const missions = this.initialState.missions ?? [];
    const selected = this.initialState.selectedMissionId ?? null;
    if (selected && missions.some((mission) => mission.id === selected)) {
      return selected;
    }
    return missions[0]?.id ?? null;
  }

  private updateMission(id: string, updater: (mission: AgentMission) => AgentMission): void {
    let changed = false;
    this.missionsSignal.update((missions) =>
      missions.map((mission) => {
        if (mission.id !== id) {
          return mission;
        }
        const next = updater(mission);
        changed ||= next !== mission;
        return next;
      }),
    );

    if (changed) {
      this.persist();
    }
  }

  private withStatus(
    mission: AgentMission,
    status: AgentMissionStatus,
    systemMessage: string,
  ): AgentMission {
    const now = new Date().toISOString();
    return {
      ...mission,
      status,
      steps: this.stepsForStatus(mission.steps, status),
      approvals: mission.approvals.map((approval) => ({
        ...approval,
        status: status === 'waiting_approval' ? approval.status : 'approved',
      })),
      messages: [
        ...mission.messages,
        {
          id: `${mission.id}-${status}-${mission.messages.length + 1}`,
          role: 'system',
          content: systemMessage,
          createdAt: now,
        },
      ],
      updatedAt: now,
    };
  }

  private stepsForStatus(
    steps: AgentMissionStep[],
    status: AgentMissionStatus,
  ): AgentMissionStep[] {
    if (status === 'planned' || status === 'waiting_approval') {
      return steps.map((step) => ({ ...step, status: 'pending' }));
    }
    if (status === 'running') {
      return steps.map((step, index) => ({
        ...step,
        status: index === 0 ? 'active' : 'pending',
      }));
    }
    if (status === 'review') {
      return steps.map((step, index) => ({
        ...step,
        status: index === steps.length - 1 ? 'active' : 'complete',
      }));
    }
    if (status === 'complete') {
      return steps.map((step) => ({ ...step, status: 'complete' }));
    }
    if (status === 'blocked') {
      return steps.map((step) => ({ ...step, status: 'blocked' }));
    }
    return steps;
  }

  private titleFor(prompt: string, kind: AgentMissionKind): string {
    const compactPrompt = prompt.replace(/\s+/g, ' ').trim();
    if (compactPrompt.length <= 72) {
      return compactPrompt;
    }
    return missionKindLabels[kind] ?? `${compactPrompt.slice(0, 69)}...`;
  }

  private inferMissionKind(prompt: string): AgentMissionKind {
    const normalized = prompt.toLowerCase();
    if (normalized.includes('project')) {
      return 'create_project';
    }
    if (normalized.includes('worktree') || normalized.includes('branch')) {
      return 'create_worktree';
    }
    if (normalized.includes('review') || normalized.includes('diff')) {
      return 'review_work';
    }
    return 'run_agent';
  }

  private stepsFor(kind: AgentMissionKind, prompt: string): AgentMissionStep[] {
    const target = this.targetSummary();
    const payload = {
      contextKind: this.contextSignal().kind,
      contextLabel: this.contextSignal().label,
      prompt,
      previewOnly: true,
    };

    type StepRow = Omit<AgentMissionStep, 'id' | 'status' | 'previewPayload'>;
    const rowsByKind: Record<AgentMissionKind, StepRow[]> = {
      create_project: [
        { kind: 'project', label: 'Draft project shell', targetSummary: target },
        { kind: 'repo', label: 'Preview repository attachments', targetSummary: target },
        { kind: 'worktree', label: 'Plan starter workspace', targetSummary: target },
        { kind: 'agent', label: 'Queue first agent session', targetSummary: target },
      ],
      create_worktree: [
        { kind: 'repo', label: 'Select base ref', targetSummary: target },
        { kind: 'worktree', label: 'Preview named worktree', targetSummary: target },
        { kind: 'agent', label: 'Prepare agent prompt', targetSummary: target },
        { kind: 'review', label: 'Set review checkpoint', targetSummary: target },
      ],
      run_agent: [
        { kind: 'worktree', label: 'Resolve execution scope', targetSummary: target },
        { kind: 'agent', label: 'Draft agent run', targetSummary: target },
        { kind: 'action', label: 'Track preview execution', targetSummary: target },
        { kind: 'review', label: 'Collect completion review', targetSummary: target },
      ],
      review_work: [
        { kind: 'review', label: 'Read changed files', targetSummary: target },
        { kind: 'agent', label: 'Inspect agent transcript', targetSummary: target },
        { kind: 'action', label: 'Prepare findings', targetSummary: target },
        { kind: 'review', label: 'Mark reviewed locally', targetSummary: target },
      ],
    };
    const rows = rowsByKind[kind];
    const deepLink = this.deepLinkTarget();

    return rows.map((row, index) => ({
      ...row,
      id: `${kind}-step-${index + 1}`,
      status: 'pending',
      // Steps that act on a concrete project/session surface a deep link to it.
      target: this.stepCanDeepLink(row.kind) ? deepLink : undefined,
      previewPayload: { ...payload, step: row.label },
    }));
  }

  /**
   * Resolve a deep-link target from the current context. Sessions take priority
   * over projects; a global context yields no target (no Open affordance).
   */
  private deepLinkTarget(): AgentDeepLinkTarget | undefined {
    const context = this.contextSignal();
    if (typeof context.sessionId === 'number') {
      return { sessionId: context.sessionId, projectId: context.projectId };
    }
    if (typeof context.projectId === 'number') {
      return { projectId: context.projectId };
    }
    return undefined;
  }

  private stepCanDeepLink(kind: AgentMissionStep['kind']): boolean {
    return kind === 'project' || kind === 'worktree' || kind === 'agent' || kind === 'review';
  }

  private artifactsFor(kind: AgentMissionKind): AgentMissionArtifact[] {
    const label = missionKindLabels[kind] ?? 'Agent';
    return [
      {
        id: `${kind}-plan`,
        kind: 'plan',
        label: 'Preview plan',
        summary: `${label} plan generated locally.`,
      },
      {
        id: `${kind}-review`,
        kind: 'review',
        label: 'Review checkpoint',
        summary: 'Reserved review checkpoint for this preview mission.',
      },
    ];
  }

  private messagesFor(
    prompt: string,
    kind: AgentMissionKind,
    createdAt: string,
  ): AgentMissionMessage[] {
    const label = missionKindLabels[kind] ?? 'Agent';
    return [
      {
        id: `${kind}-user`,
        role: 'user',
        content: prompt,
        createdAt,
      },
      {
        id: `${kind}-agent`,
        role: 'agent',
        content: `${label} preview prepared for ${this.targetSummary()}.`,
        createdAt,
      },
    ];
  }

  private targetSummary(): string {
    return 'Elevenex';
  }

  private loadState(): PersistedAgentControlState {
    const storage = this.storage();
    if (!storage) {
      return {};
    }

    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw) as PersistedAgentControlState;
      const missions = Array.isArray(parsed.missions) ? parsed.missions : [];
      return {
        ...parsed,
        // Backfill autonomy mode for missions persisted before it existed.
        missions: missions.map((mission) => ({
          ...mission,
          autonomyMode: mission.autonomyMode ?? DEFAULT_AGENT_AUTONOMY_MODE,
        })),
      };
    } catch {
      return {};
    }
  }

  private persist(): void {
    const storage = this.storage();
    if (!storage) {
      return;
    }

    try {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          context: this.contextSignal(),
          selectedMissionId: this.selectedMissionIdSignal(),
          missions: this.missionsSignal(),
          sequence: this.sequenceSignal(),
          autonomyMode: this.autonomyModeSignal(),
        } satisfies PersistedAgentControlState),
      );
    } catch {
      // Ignore persistence failures.
    }
  }

  private storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  }
}
