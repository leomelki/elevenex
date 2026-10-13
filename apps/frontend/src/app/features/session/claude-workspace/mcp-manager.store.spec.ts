import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import type { AgentMcpSnapshot } from '@/shared/models/agent-runtime.model';
import { McpManagerStore } from './mcp-manager.store';

const snapshot = (name = 'docs'): AgentMcpSnapshot => ({
  servers: [
    {
      entryId: `pi:project:${name}`,
      name,
      scope: 'project',
      transport: 'http',
      configLocation: '/tmp/mcp.json',
      enabled: true,
      connectionStatus: 'unknown',
      configStatus: 'valid',
      revision: 'revision',
      actions: {
        canToggle: true,
        canRecheck: false,
        canAuth: false,
        canReauth: false,
        canViewTools: false,
      },
    },
  ],
  diagnostics: [],
  summary: { total: 1, connected: 0, needsAuth: 0, failed: 0, disabled: 0, malformed: 0 },
  lastUpdatedAt: new Date().toISOString(),
});
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('MCP manager store', () => {
  let store: McpManagerStore;
  let provider: ReturnType<typeof signal<string>>;
  let api: {
    getMcpSnapshot: ReturnType<typeof vi.fn>;
    saveMcpServer: ReturnType<typeof vi.fn>;
    getMcpServerDefinition: ReturnType<typeof vi.fn>;
    toggleMcpServer: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    api = {
      getMcpSnapshot: vi.fn(() => of(snapshot())),
      saveMcpServer: vi.fn(() => of(snapshot('saved'))),
      getMcpServerDefinition: vi.fn(),
      toggleMcpServer: vi.fn(() => of(snapshot())),
    };
    TestBed.configureTestingModule({
      providers: [McpManagerStore, { provide: ClaudeRuntimeApiService, useValue: api }],
    });
    store = TestBed.inject(McpManagerStore);
    provider = signal('pi');
    TestBed.runInInjectionContext(() => store.bind(signal(1), provider));
    TestBed.tick();
  });

  it('cancels a slow refresh before saving and retains the saved snapshot', async () => {
    const refresh = new Subject<AgentMcpSnapshot>();
    api.getMcpSnapshot.mockReturnValue(refresh);
    store.show();
    store.save({ name: 'saved', scope: 'project', transport: 'http', url: 'https://example.com' });
    await settle();
    refresh.next(snapshot('old'));
    refresh.complete();
    await settle();
    expect(store.snapshot()?.servers[0].name).toBe('saved');
    expect(store.loading()).toBe(false);
    expect(store.busy()).toBeNull();
  });

  it('keeps existing cards visible during refresh and provides a recoverable error', async () => {
    store.show();
    await settle();
    api.getMcpSnapshot.mockReturnValue(throwError(() => ({ error: { message: 'Disconnected' } })));
    await store.load();
    expect(store.snapshot()?.servers[0].name).toBe('docs');
    expect(store.error()).toBe('Disconnected');
    api.getMcpSnapshot.mockReturnValue(of(snapshot()));
    await store.load();
    expect(store.error()).toBeNull();
  });

  it('clears provider-specific state and ignores the previous provider response', async () => {
    const refresh = new Subject<AgentMcpSnapshot>();
    api.getMcpSnapshot.mockReturnValue(refresh);
    store.show();
    provider.set('codex');
    TestBed.tick();
    refresh.next(snapshot('pi-server'));
    await settle();
    expect(store.snapshot()).toBeNull();
    expect(store.open()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('uses the scoped entry id for toggles', async () => {
    store.toggle(snapshot().servers[0]);
    await settle();
    expect(api.toggleMcpServer).toHaveBeenCalledWith(1, 'pi:project:docs');
  });

  it('retains the draft after a rejected save', async () => {
    store.add();
    api.saveMcpServer.mockReturnValue(
      throwError(() => ({ error: { message: 'Changed elsewhere' } })),
    );
    store.save({ name: 'docs', scope: 'project', transport: 'http', url: 'https://example.com' });
    await settle();
    expect(store.draft()).not.toBeNull();
    expect(store.error()).toBe('Changed elsewhere');
    await store.load(true);
    expect(store.error()).toBe('Changed elsewhere');
  });

  it('keeps the selected scoped entry when a refresh reorders duplicate server names', async () => {
    const current = snapshot();
    const userEntry = { ...current.servers[0], scope: 'user' as const, entryId: 'pi:user:docs' };
    api.getMcpSnapshot.mockReturnValue(
      of({ ...current, servers: [current.servers[0], userEntry] }),
    );
    store.show();
    await settle();
    store.select(userEntry);
    api.getMcpSnapshot.mockReturnValue(
      of({ ...current, servers: [userEntry, current.servers[0]] }),
    );
    await store.load(true);
    expect(store.selectedId()).toBe('pi:user:docs');
  });

  it('protects unsaved changes on close and allows returning to the same draft', () => {
    store.open.set(true);
    store.add();
    const draft = store.draft();
    store.editorDirty.set(true);
    store.close();
    expect(store.open()).toBe(true);
    expect(store.discardPending()).toBe(true);
    store.keepEditing();
    expect(store.draft()).toBe(draft);
    expect(store.discardPending()).toBe(false);
    store.close();
    store.discardChanges();
    expect(store.open()).toBe(false);
    expect(store.draft()).toBeNull();
  });

  it('defers changing servers until unsaved changes are discarded', () => {
    store.add();
    store.editorDirty.set(true);
    const server = snapshot().servers[0];
    store.select(server);
    expect(store.selectedId()).toBeNull();
    expect(store.draft()).not.toBeNull();
    store.discardChanges();
    expect(store.selectedId()).toBe(server.entryId);
    expect(store.draft()).toBeNull();
  });

  it('does not reopen a canceled editor when its definition arrives late', async () => {
    const response = new Subject();
    api.getMcpServerDefinition.mockReturnValue(response);
    store.edit(snapshot().servers[0]);
    TestBed.tick();
    expect(store.editorLoading()).toBe(true);
    store.cancelEditor();
    response.next({ name: 'late', scope: 'project', transport: 'http' });
    await settle();
    expect(store.draft()).toBeNull();
    expect(store.editorLoading()).toBe(false);
  });

  it('keeps the editor request valid when a completion event requests a refresh', async () => {
    const response = new Subject();
    api.getMcpServerDefinition.mockReturnValue(response);
    store.edit(snapshot().servers[0]);
    expect(store.editorLoading()).toBe(true);
    await store.load(true);
    response.next({
      name: 'docs',
      scope: 'project',
      transport: 'http',
      url: 'https://example.com',
    });
    response.complete();
    await settle();
    expect(store.editorLoading()).toBe(false);
    expect(store.draft()?.name).toBe('docs');
    expect(api.getMcpSnapshot).not.toHaveBeenCalled();
  });
});
