import { Test, type TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'node:events';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import {
  ClaudeHooksService,
  type ClaudeSessionActivity,
} from '../claude-hooks/claude-hooks.service.js';
import { NavigationEventsService } from '../navigation/navigation-events.service.js';
import {
  DesktopWorkspaceActivityService,
  type WorkspaceSessionActivity,
} from './desktop-workspace-activity.service.js';

const session = (
  id: number,
  patch: Partial<WorkspaceSessionActivity> = {},
): WorkspaceSessionActivity => ({
  id,
  activeAgentProvider: 'claude',
  status: 'active',
  hasUnreviewedCompletion: false,
  lastCompletionAt: null,
  ...patch,
});
describe('bounded workspace sidebar activity', () => {
  let module: TestingModule;
  let service: DesktopWorkspaceActivityService;
  let navigation: NavigationEventsService;
  const snapshots = new Map<number, ClaudeSessionActivity>();
  const provider = Object.assign(new EventEmitter(), {
    info: { id: 'claude' },
    getRuntimeState: jest.fn(),
    getHistory: jest.fn(),
    getSnapshot: jest.fn(),
  });
  const hooks = Object.assign(new EventEmitter(), {
    getActivity: (id: number): ClaudeSessionActivity =>
      snapshots.get(id) ?? {
        activityStatus: 'idle',
        actionKind: null,
        actionLabel: null,
        backgroundActive: false,
      },
  });
  const emit = (id: number, state: object) =>
    provider.emit('event', {
      type: 'run_state',
      payload: { sessionId: id, ...state },
    });
  beforeEach(async () => {
    snapshots.clear();
    provider.removeAllListeners();
    hooks.removeAllListeners();
    provider.getRuntimeState.mockClear();
    provider.getHistory.mockClear();
    provider.getSnapshot.mockClear();
    module = await Test.createTestingModule({
      providers: [
        DesktopWorkspaceActivityService,
        NavigationEventsService,
        {
          provide: AgentRuntimeRegistryService,
          useValue: {
            listProviders: () => [provider.info],
            getProvider: () => provider,
          },
        },
        { provide: ClaudeHooksService, useValue: hooks },
      ],
    }).compile();
    await module.init();
    service = module.get(DesktopWorkspaceActivityService);
    navigation = module.get(NavigationEventsService);
  });
  afterEach(async () => module.close());
  it('reports nonselected running and needs-input sessions without reading provider histories or hydrating runtimes', () => {
    snapshots.set(1, {
      activityStatus: 'running',
      actionKind: null,
      actionLabel: null,
      backgroundActive: false,
    });
    snapshots.set(2, {
      activityStatus: 'waiting',
      actionKind: 'permission',
      actionLabel: 'Permission needed',
      backgroundActive: true,
    });
    emit(3, { pendingUserInputRequest: { requestId: 'question' } });
    expect([1, 2, 3].map((id) => service.status(session(id)))).toEqual([
      'running',
      'attention',
      'attention',
    ]);
    expect(provider.getRuntimeState).not.toHaveBeenCalled();
    expect(provider.getHistory).not.toHaveBeenCalled();
    expect(provider.getSnapshot).not.toHaveBeenCalled();
  });
  it('combines bounded provider error/queue state with durable completion and archived history', () => {
    emit(1, { runPhase: 'error', lastError: 'Runtime failed' });
    emit(2, { runPhase: 'idle', pendingPrompts: [{ id: 'queued' }] });
    expect(service.status(session(1))).toBe('failed');
    expect(service.status(session(2))).toBe('queued');
    expect(
      service.status(
        session(3, {
          hasUnreviewedCompletion: true,
          lastCompletionAt: '2026-10-26',
        }),
      ),
    ).toBe('review');
    expect(service.status(session(4, { lastCompletionAt: '2026-10-26' }))).toBe(
      'done',
    );
    expect(service.status(session(1, { status: 'archived' }))).toBe('archived');
    emit(1, { runPhase: 'running', canInterrupt: true, lastError: null });
    expect(service.status(session(1))).toBe('running');
  });
  it('invalidates only changed semantic activity and cleans every listener on teardown', async () => {
    emit(1, { runPhase: 'running', canInterrupt: true });
    const revision = navigation.revision;
    emit(1, {
      runPhase: 'running',
      canInterrupt: true,
      liveItems: ['another token'],
    });
    provider.emit('event', {
      type: 'message_delta',
      payload: { sessionId: 1, text: 'stream' },
    });
    expect(navigation.revision).toBe(revision);
    emit(1, {
      runPhase: 'waiting',
      pendingPermissionRequest: { requestId: 'permission' },
    });
    expect(navigation.revision).toBe(revision + 1);
    hooks.emit('status-changed', { sessionId: 2 });
    const hookRevision = navigation.revision;
    hooks.emit('status-changed', { sessionId: 2 });
    expect(navigation.revision).toBe(hookRevision);
    await module.close();
    expect(provider.listenerCount('event')).toBe(0);
    expect(hooks.listenerCount('status-changed')).toBe(0);
  });
});
