import { Injectable, computed, signal } from '@angular/core';
import {
  AGENT_CONTROL_GLOBAL_CONTEXT,
  AgentControlContext,
  AgentMission,
  AgentMissionArtifact,
  AgentMissionMessage,
  AgentMissionStatus,
  AgentMissionStep,
  AgentMissionTemplate,
} from './agent-control.model';

interface PersistedAgentControlState {
  context?: AgentControlContext;
  selectedMissionId?: string | null;
  missions?: AgentMission[];
  sequence?: number;
}

const STORAGE_KEY = 'elevenex-agent-control-state';

const templates: AgentMissionTemplate[] = [
  {
    id: 'create_project',
    label: 'Create project',
    description: 'Preview project creation, repository attachment, and starter workspace setup.',
    icon: 'lucideFolder',
    prompt: 'Create a new Elevenex project, attach the right repositories, and prepare an initial workspace.',
  },
  {
    id: 'create_worktree',
    label: 'Create worktree',
    description: 'Preview branch selection, worktree creation, and session bootstrapping.',
    icon: 'lucideGitBranch',
    prompt: 'Create a focused worktree from the best base ref and open a session for the agent.',
  },
  {
    id: 'run_agent',
    label: 'Run agent',
    description: 'Preview an agent run against the selected project, worktree, or session.',
    icon: 'lucidePlay',
    prompt: 'Run an agent on the selected scope, keep a review checkpoint, and summarize the result.',
  },
  {
    id: 'review_work',
    label: 'Review work',
    description: 'Preview transcript, diff, and completion review steps before accepting work.',
    icon: 'lucideClipboardList',
    prompt: 'Review the selected work, inspect changed files and agent output, and prepare findings.',
  },
];

@Injectable({ providedIn: 'root' })
export class AgentControlStateService {
  readonly templates = templates;

  private readonly initialState = this.loadState();
  private readonly openSignal = signal(false);
  private readonly contextSignal = signal<AgentControlContext>(
    this.initialState.context ?? AGENT_CONTROL_GLOBAL_CONTEXT,
  );
  private readonly missionsSignal = signal<AgentMission[]>(this.initialState.missions ?? []);
  private readonly selectedMissionIdSignal = signal<string | null>(
    this.resolveInitialSelectedMissionId(),
  );
  private readonly sequenceSignal = signal(this.initialState.sequence ?? 0);

  readonly isOpen = this.openSignal.asReadonly();
  readonly context = this.contextSignal.asReadonly();
  readonly missions = this.missionsSignal.asReadonly();
  readonly selectedMissionId = this.selectedMissionIdSignal.asReadonly();
  readonly selectedMission = computed(() => {
    const id = this.selectedMissionIdSignal();
    return this.missionsSignal().find(mission => mission.id === id) ?? null;
  });
  readonly activeMissionsCount = computed(() =>
    this.missionsSignal().filter(mission =>
      mission.status !== 'complete' && mission.status !== 'blocked',
    ).length,
  );

  open(context: AgentControlContext = AGENT_CONTROL_GLOBAL_CONTEXT): void {
    this.contextSignal.set(this.normalizeContext(context));
    this.openSignal.set(true);
    this.persist();
  }

  openGlobal(): void {
    this.open(AGENT_CONTROL_GLOBAL_CONTEXT);
  }

  openProject(project: { id: number; name: string }): void {
    this.open({
      kind: 'project',
      label: project.name,
      projectId: project.id,
      projectName: project.name,
    });
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
    this.open({
      kind: 'session',
      label: context.sessionName,
      projectId: context.projectId,
      repoId: context.repoId,
      sessionId: context.sessionId,
      sessionName: context.sessionName,
      worktreePath: context.worktreePath,
      workspaceName: context.workspaceName,
      branchName: context.branchName,
    });
  }

  close(): void {
    this.openSignal.set(false);
  }

  selectMission(id: string): void {
    if (!this.missionsSignal().some(mission => mission.id === id)) {
      return;
    }
    this.selectedMissionIdSignal.set(id);
    this.persist();
  }

  createMission(prompt: string, templateId?: AgentMissionTemplate['id']): AgentMission | null {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      return null;
    }

    const template = templates.find(candidate => candidate.id === templateId);
    const kind = template?.id ?? this.inferTemplateId(cleanPrompt);
    const now = new Date().toISOString();
    const sequence = this.sequenceSignal() + 1;
    this.sequenceSignal.set(sequence);

    const mission: AgentMission = {
      id: `mission-${sequence}`,
      title: this.titleFor(cleanPrompt, kind),
      prompt: cleanPrompt,
      status: 'waiting_approval',
      context: this.contextSignal(),
      steps: this.stepsFor(kind, cleanPrompt),
      approvals: [
        {
          id: `mission-${sequence}-approval-plan`,
          label: 'Approve preview plan',
          status: 'pending',
          summary: 'No project, worktree, session, process, or file change will be made.',
        },
      ],
      artifacts: this.artifactsFor(kind),
      messages: this.messagesFor(cleanPrompt, kind, now),
      createdAt: now,
      updatedAt: now,
    };

    this.missionsSignal.update(missions => [mission, ...missions]);
    this.selectedMissionIdSignal.set(mission.id);
    this.openSignal.set(true);
    this.persist();
    return mission;
  }

  createMissionFromTemplate(templateId: AgentMissionTemplate['id']): AgentMission | null {
    const template = templates.find(candidate => candidate.id === templateId);
    return template ? this.createMission(template.prompt, template.id) : null;
  }

  approveMission(id: string): void {
    this.updateMission(id, mission =>
      mission.status === 'waiting_approval'
        ? this.withStatus(mission, 'planned', 'Preview plan approved locally.')
        : mission,
    );
  }

  runMission(id: string): void {
    this.updateMission(id, mission =>
      mission.status === 'planned'
        ? this.withStatus(mission, 'running', 'Preview run started locally.')
        : mission,
    );
  }

  reviewMission(id: string): void {
    this.updateMission(id, mission =>
      mission.status === 'running'
        ? this.withStatus(mission, 'review', 'Preview run moved into review.')
        : mission,
    );
  }

  completeMission(id: string): void {
    this.updateMission(id, mission =>
      mission.status === 'review'
        ? this.withStatus(mission, 'complete', 'Preview mission marked complete.')
        : mission,
    );
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
    if (selected && missions.some(mission => mission.id === selected)) {
      return selected;
    }
    return missions[0]?.id ?? null;
  }

  private normalizeContext(context: AgentControlContext): AgentControlContext {
    if (context.kind === 'global') {
      return AGENT_CONTROL_GLOBAL_CONTEXT;
    }

    return {
      ...context,
      label: context.label || context.projectName || context.sessionName || 'Selected context',
    };
  }

  private updateMission(id: string, updater: (mission: AgentMission) => AgentMission): void {
    let changed = false;
    this.missionsSignal.update(missions =>
      missions.map(mission => {
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
      approvals: mission.approvals.map(approval => ({
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

  private stepsForStatus(steps: AgentMissionStep[], status: AgentMissionStatus): AgentMissionStep[] {
    if (status === 'planned' || status === 'waiting_approval') {
      return steps.map(step => ({ ...step, status: 'pending' }));
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
      return steps.map(step => ({ ...step, status: 'complete' }));
    }
    if (status === 'blocked') {
      return steps.map(step => ({ ...step, status: 'blocked' }));
    }
    return steps;
  }

  private titleFor(prompt: string, kind: AgentMissionTemplate['id']): string {
    const template = templates.find(candidate => candidate.id === kind);
    const compactPrompt = prompt.replace(/\s+/g, ' ').trim();
    if (compactPrompt.length <= 72) {
      return compactPrompt;
    }
    return template?.label ?? `${compactPrompt.slice(0, 69)}...`;
  }

  private inferTemplateId(prompt: string): AgentMissionTemplate['id'] {
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

  private stepsFor(kind: AgentMissionTemplate['id'], prompt: string): AgentMissionStep[] {
    const target = this.targetSummary();
    const payload = {
      contextKind: this.contextSignal().kind,
      contextLabel: this.contextSignal().label,
      prompt,
      previewOnly: true,
    };

    type StepRow = Omit<AgentMissionStep, 'id' | 'status' | 'previewPayload'>;
    const rowsByKind: Record<AgentMissionTemplate['id'], StepRow[]> = {
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

    return rows.map((row, index) => ({
      ...row,
      id: `${kind}-step-${index + 1}`,
      status: 'pending',
      previewPayload: { ...payload, step: row.label },
    }));
  }

  private artifactsFor(kind: AgentMissionTemplate['id']): AgentMissionArtifact[] {
    const template = templates.find(candidate => candidate.id === kind);
    return [
      {
        id: `${kind}-plan`,
        kind: 'plan',
        label: 'Preview plan',
        summary: `${template?.label ?? 'Agent'} plan generated locally.`,
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
    kind: AgentMissionTemplate['id'],
    createdAt: string,
  ): AgentMissionMessage[] {
    const template = templates.find(candidate => candidate.id === kind);
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
        content: `${template?.label ?? 'Agent'} preview prepared for ${this.targetSummary()}.`,
        createdAt,
      },
    ];
  }

  private targetSummary(): string {
    const context = this.contextSignal();
    if (context.kind === 'global') {
      return 'all Elevenex projects';
    }
    if (context.kind === 'project') {
      return `project ${context.projectName ?? context.label}`;
    }
    if (context.kind === 'repo') {
      return `repository ${context.repoName ?? context.label}`;
    }
    if (context.kind === 'worktree') {
      return context.workspaceName || context.worktreePath || context.label;
    }
    return context.sessionName || `session ${context.sessionId}`;
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
      return {
        ...parsed,
        missions: Array.isArray(parsed.missions) ? parsed.missions : [],
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
