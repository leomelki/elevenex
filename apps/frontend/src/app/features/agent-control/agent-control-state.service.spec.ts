import { TestBed } from '@angular/core/testing';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { Subject, of } from 'rxjs';

import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentControlStateService } from './agent-control-state.service';
import { AgentMissionsApiService } from './agent-missions-api.service';
import { MissionSummary } from './agent-control.model';

function mission(over: Partial<MissionSummary> = {}): MissionSummary {
  return {
    sessionId: 1,
    title: 'Mission 1',
    status: 'active',
    runPhase: 'running',
    awaitingApproval: false,
    autonomyMode: 'review',
    repoId: 7,
    worktreePath: '/ws',
    deepLink: '/sessions/1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('AgentControlStateService', () => {
  let api: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    setAutonomy: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    archive: ReturnType<typeof vi.fn>;
  };
  let runtimeEvents: Subject<{ type: string; payload?: Record<string, unknown> }>;
  let history: unknown[];

  function makeService(): AgentControlStateService {
    runtimeEvents = new Subject();
    history = [];
    api = {
      list: vi.fn(() => of([mission()])),
      create: vi.fn(() => of({ sessionId: 1, deepLink: '/sessions/1' })),
      setAutonomy: vi.fn((id: number, mode: string) =>
        of(mission({ sessionId: id, autonomyMode: mode as never })),
      ),
      interrupt: vi.fn(() => of({ ok: true })),
      archive: vi.fn(() => of({ ok: true })),
    };

    TestBed.configureTestingModule({
      providers: [
        AgentControlStateService,
        { provide: AgentMissionsApiService, useValue: api },
        {
          provide: AgentRuntimeWebsocketService,
          useValue: { connect: () => runtimeEvents.asObservable() },
        },
        { provide: AgentRuntimeApiService, useValue: { getHistory: () => of(history) } },
      ],
    });
    return TestBed.inject(AgentControlStateService);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('refresh loads missions and selects the first', async () => {
    const service = makeService();
    await service.refresh();
    expect(api.list).toHaveBeenCalled();
    expect(service.missions().length).toBe(1);
    expect(service.selectedMissionId()).toBe(1);
  });

  it('createMission posts, refreshes, and selects the new mission', async () => {
    const service = makeService();
    const id = await service.createMission('Do a thing', 'plan');
    expect(api.create).toHaveBeenCalledWith({ prompt: 'Do a thing', autonomyMode: 'plan' });
    expect(id).toBe(1);
    expect(service.selectedMissionId()).toBe(1);
    expect(service.isOpen()).toBe(true);
  });

  it('createMission ignores blank prompts', async () => {
    const service = makeService();
    const id = await service.createMission('   ');
    expect(id).toBeNull();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('setMissionAutonomy patches the mission in place', async () => {
    const service = makeService();
    await service.refresh();
    await service.setMissionAutonomy(1, 'full');
    expect(api.setAutonomy).toHaveBeenCalledWith(1, 'full');
    expect(service.selectedMission()?.autonomyMode).toBe('full');
  });

  it('live run_state events update the mission row status', async () => {
    const service = makeService();
    await service.refresh();
    runtimeEvents.next({
      type: 'run_state',
      payload: { runPhase: 'waiting', pendingPermissionRequest: { id: 'x' } },
    });
    const m = service.selectedMission();
    expect(m?.runPhase).toBe('waiting');
    expect(m?.awaitingApproval).toBe(true);
  });

  it('derives the step tree from a TodoWrite tool_use event', async () => {
    const service = makeService();
    await service.refresh();
    runtimeEvents.next({
      type: 'tool_use',
      payload: {
        item: {
          kind: 'tool_use',
          toolName: 'TodoWrite',
          toolInput: {
            todos: [
              { content: 'Set up project', status: 'completed' },
              { content: 'Run session', activeForm: 'Running session', status: 'in_progress' },
              { content: 'Verify', status: 'pending' },
            ],
          },
        },
      },
    });
    const steps = service.selectedSteps();
    expect(steps.map((s) => s.status)).toEqual(['complete', 'active', 'pending']);
    // in_progress todos render their activeForm.
    expect(steps[1].label).toBe('Running session');
  });

  it('archiveMission archives and refreshes', async () => {
    const service = makeService();
    await service.refresh();
    await service.archiveMission(1);
    expect(api.archive).toHaveBeenCalledWith(1);
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});
