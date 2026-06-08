import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { AgentControlStateService } from './agent-control-state.service';

const STORAGE_KEY = 'elevenex-agent-control-state';

function installLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
      clear: vi.fn(() => values.clear()),
    },
  });
  return values;
}

describe('AgentControlStateService', () => {
  let storageValues: Map<string, string>;
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    originalLocalStorage = globalThis.localStorage;
    storageValues = installLocalStorage();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it('opens as a global controller and persists created preview missions', () => {
    const service = new AgentControlStateService();
    service.openProject({ id: 7, name: 'Platform' });

    const mission = service.createMission('Review the current work before it ships');

    expect(service.isOpen()).toBe(true);
    expect(service.context()).toEqual({ kind: 'global', label: 'Elevenex' });
    expect(mission?.status).toBe('waiting_approval');
    expect(service.selectedMission()).toEqual(mission);

    const persisted = JSON.parse(storageValues.get(STORAGE_KEY) ?? '{}');
    expect(persisted.missions).toHaveLength(1);
    expect(persisted.context).toEqual({ kind: 'global', label: 'Elevenex' });

    const restored = new AgentControlStateService();
    expect(restored.missions()[0].title).toBe(mission?.title);
    expect(restored.selectedMissionId()).toBe(mission?.id);
  });

  it('advances preview-only missions through local statuses', () => {
    const service = new AgentControlStateService();
    const mission = service.createMission(
      'Run an agent on the selected scope and summarize the result',
    );
    expect(mission).toBeTruthy();

    service.approveMission(mission!.id);
    expect(service.selectedMission()?.status).toBe('planned');

    service.runMission(mission!.id);
    expect(service.selectedMission()?.status).toBe('running');
    expect(service.selectedMission()?.steps[0].status).toBe('active');

    service.reviewMission(mission!.id);
    expect(service.selectedMission()?.status).toBe('review');
    expect(service.selectedMission()?.steps.at(-1)?.status).toBe('active');

    service.completeMission(mission!.id);
    expect(service.selectedMission()?.status).toBe('complete');
    expect(service.selectedMission()?.steps.every((step) => step.status === 'complete')).toBe(true);
  });

  it('resets missions and selected state without closing the drawer', () => {
    const service = new AgentControlStateService();
    service.openGlobal();
    service.createMission('Create a new Elevenex project and prepare an initial workspace');

    service.reset();

    expect(service.isOpen()).toBe(true);
    expect(service.missions()).toEqual([]);
    expect(service.selectedMission()).toBeNull();
  });
});
