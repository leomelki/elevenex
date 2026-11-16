import { Test, type TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'node:events';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import {
  ClaudeHooksService,
  type ClaudeSessionActivity,
} from '../claude-hooks/claude-hooks.service.js';
import { NavigationEventsService } from '../navigation/navigation-events.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
jest.mock('../sessions/sessions.service.js', () => ({ SessionsService: class SessionsService {} }));
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
  status: 'created',
  hasUnreviewedCompletion: false,
  lastCompletionAt: null,
  ...patch,
});
describe('bounded workspace sidebar activity', () => {
  let module: TestingModule;
  let service: DesktopWorkspaceActivityService;
  let navigation: NavigationEventsService;
  const snapshots = new Map<number, ClaudeSessionActivity>();
  const sessions = new EventEmitter();
  const codex = Object.assign(new EventEmitter(), { info: { id: 'codex' } });
  const providers = new Map(['claude', 'codex', 'pi', 'opencode', 'custom-harness'].map(id => [id, id === 'codex' ? codex : Object.assign(new EventEmitter(), { info: { id } })]));
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
    providers.set('claude', provider);
    for (const runtime of providers.values()) runtime.removeAllListeners();
    provider.removeAllListeners();
    hooks.removeAllListeners();
    sessions.removeAllListeners(); codex.removeAllListeners();
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
            listProviders: () => [...providers.values()].map(runtime => runtime.info),
            getProvider: (id: string) => providers.get(id)!,
          },
        },
        { provide: ClaudeHooksService, useValue: hooks },
        { provide: SessionsService, useValue: sessions },
      ],
    }).compile();
    await module.init();
    service = module.get(DesktopWorkspaceActivityService);
    navigation = module.get(NavigationEventsService);
  });
  afterEach(async () => module.close());
  it.each(['claude', 'codex', 'pi', 'opencode', 'custom-harness'])(
    'normalizes every scalar status for %s without hydrating a runtime', providerId => {
      const target = session(1, { activeAgentProvider: providerId, status: 'active' });
      const emitter = providers.get(providerId)!;
      for (const [state, expected] of [
        [{ sessionState: 'requires_action' }, 'attention'],
        [{ sessionState: 'waiting_for_input' }, 'attention'],
        [{ runPhase: 'running', pendingPermissionRequest: {} }, 'attention'],
        [{ runPhase: 'running' }, 'running'],
        [{ runPhase: 'idle', backgroundWork: [{ id: 'agent' }] }, 'running'],
        [{ runPhase: 'idle', backgroundRunActive: true }, 'running'],
        [{ runPhase: 'error', canInterrupt: true }, 'failed'],
        [{ lastError: 'Failed to initialize' }, 'failed'],
        [{ runPhase: 'idle', pendingPrompts: [{}] }, 'queued'],
        [{ runPhase: 'idle', pendingPrompts: [] }, 'done'],
      ] as const) {
        emitter.emit('event', { type: 'run_state', payload: { sessionId: 1, ...state } });
        expect(service.status(target)).toBe(expected);
      }
    },
  );
  it('retains a terminal failure until the next turn, with explicit input taking priority', () => {
    snapshots.set(1, { activityStatus: 'idle', actionKind: null, actionLabel: null, backgroundActive: false, failed: true });
    hooks.emit('status-changed', { sessionId: 1 });
    expect(service.status(session(1))).toBe('failed');
    snapshots.set(1, { activityStatus: 'waiting', actionKind: 'permission', actionLabel: null, backgroundActive: true });
    hooks.emit('status-changed', { sessionId: 1 });
    expect(service.status(session(1))).toBe('attention');
  });
  it('recovers old inactive conversations without completion stamps or history hydration', () => {
    for (const identity of [{ claudeSessionId: 'old' }, { codexSessionId: 'old' }, { piSessionPath: '/old.jsonl' }, { opencodeSessionId: 'old' }]) {
      expect(service.status(session(1, identity))).toBe('done');
      expect(service.status(session(1, { ...identity, hasUnreviewedCompletion: true, lastCompletionAt: '2026-11-15T00:00:00.000Z' }))).toBe('review');
    }
    expect(service.status(session(2, { status: 'active' }))).toBe('done');
    expect(service.status(session(3))).toBe('queued');
    expect(service.status(session(4, { hasUnreviewedCompletion: true, lastCompletionAt: null }))).toBe('done');
    expect(provider.getHistory).not.toHaveBeenCalled();
    expect(provider.getRuntimeState).not.toHaveBeenCalled();
  });
  it('uses the inferred provider for legacy live sessions', () => {
    codex.emit('event', { type: 'run_state', payload: { sessionId: 1, runPhase: 'running' } });
    expect(service.status(session(1, { codexSessionId: 'old' }))).toBe('running');
    expect(service.status(session(1, { activeAgentProvider: 'pi', codexSessionId: 'old' }))).toBe('done');
    hooks.emit('status-changed', { sessionId: 1, provider: 'claude' });
    expect(service.status(session(1, { codexSessionId: 'old' }))).toBe('running');
    hooks.emit('status-changed', { sessionId: 1, provider: 'codex' });
    expect(service.status(session(1, { codexSessionId: 'old' }))).toBe('done');
  });
  it('keeps live work through thousands of quiet session snapshots without repeated invalidations', () => {
    emit(1, { runPhase: 'running' });
    const revision = navigation.revision;
    for (let id = 2; id <= 5000; id++) emit(id, { runPhase: 'idle', canInterrupt: false });
    expect(service.status(session(1, { status: 'active' }))).toBe('running');
    expect(navigation.revision).toBe(revision);
    expect(provider.getHistory).not.toHaveBeenCalled();
    expect(provider.getRuntimeState).not.toHaveBeenCalled();
  });
  it('clears stale activity on teardown and lifecycle changes without hiding live work', () => {
    emit(1, { runPhase: 'running' });
    snapshots.set(1, { activityStatus: 'idle', actionKind: null, actionLabel: null, backgroundActive: true });
    hooks.emit('status-changed', { sessionId: 1 });
    expect(service.status(session(1, { status: 'active' }))).toBe('running');
    snapshots.delete(1); hooks.emit('status-changed', { sessionId: 1 });
    expect(service.status(session(1, { status: 'active' }))).toBe('done');
    emit(2, { runPhase: 'idle', pendingPrompts: [{ id: 'old-queue' }] });
    sessions.emit('session-status-changed', { sessionId: 2, status: 'archived' });
    expect(service.status(session(2, { status: 'active' }))).toBe('done');
    snapshots.set(2, { activityStatus: 'running', actionKind: null, actionLabel: null, backgroundActive: true });
    expect(service.status(session(2, { status: 'stopped' }))).toBe('done');
    expect(service.status(session(2, { status: 'archived', hasUnreviewedCompletion: true }))).toBe('archived');
  });
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
    expect(codex.listenerCount('event')).toBe(0);
    expect(sessions.listenerCount('session-status-changed')).toBe(0);
  });
});
