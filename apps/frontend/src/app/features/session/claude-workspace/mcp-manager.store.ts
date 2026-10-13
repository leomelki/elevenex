import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, interval, Subject, takeUntil, timeout, type Observable } from 'rxjs';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { getHttpErrorMessage } from './workspace-error';
import type {
  AgentMcpServerEntry,
  AgentMcpSnapshot,
  McpServerDefinition,
} from '@/shared/models/agent-runtime.model';

export type McpOperation = 'save' | 'remove' | 'toggle' | 'check' | 'reload' | 'auth';

/** Session-scoped MCP state. Canceled or older responses can never replace a save. */
@Injectable()
export class McpManagerStore {
  private readonly api = inject(ClaudeRuntimeApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly canceled = new Subject<void>();
  private version = 0;
  private sessionId!: Signal<number>;
  readonly open = signal(false);
  readonly loading = signal(false);
  readonly snapshot = signal<AgentMcpSnapshot | null>(null);
  readonly busy = signal<string | null>(null);
  readonly operation = signal<McpOperation | null>(null);
  readonly error = signal<string | null>(null);
  readonly draft = signal<McpServerDefinition | null>(null);
  readonly editingId = signal<string | undefined>(undefined);
  readonly editorLoading = signal(false);
  readonly selectedId = signal<string | null>(null);
  readonly editorDirty = signal(false);
  readonly discardPending = signal(false);
  private pendingNavigation: (() => void) | null = null;
  readonly authorization = new Subject<{ url: string; message: string }>();

  constructor() {
    interval(5_000)
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.open() && !this.loading() && !this.busy() && !this.editorLoading())
          void this.load(true);
      });
  }

  bind(sessionId: Signal<number>, provider: Signal<string>, visible?: Signal<boolean>): void {
    this.sessionId = sessionId;
    effect(() => {
      sessionId();
      provider();
      visible?.();
      untracked(() => this.reset());
    });
  }

  reset(): void {
    this.version++;
    this.canceled.next();
    this.open.set(false);
    this.loading.set(false);
    this.busy.set(null);
    this.operation.set(null);
    this.snapshot.set(null);
    this.error.set(null);
    this.draft.set(null);
    this.editingId.set(undefined);
    this.editorLoading.set(false);
    this.selectedId.set(null);
    this.clearEditor();
  }

  show(): void {
    this.open.set(true);
    void this.load();
  }
  close(): void {
    if (this.busy()) return;
    this.navigate(() => {
      this.version++;
      this.canceled.next();
      this.open.set(false);
      this.loading.set(false);
      this.editorLoading.set(false);
      this.clearEditor();
    });
  }

  async load(background = false): Promise<void> {
    if (this.loading() || this.busy() || this.editorLoading()) return;
    const version = ++this.version;
    this.loading.set(true);
    if (!background) this.error.set(null);
    try {
      const result = await this.read(
        this.api.getMcpSnapshot(this.sessionId(), !background && !!this.snapshot()),
      );
      if (version === this.version) {
        this.applySnapshot(result);
        if (!background) this.error.set(null);
      }
    } catch (error) {
      if (version === this.version && !background)
        this.error.set(getHttpErrorMessage(error, 'Could not load MCP servers. Try refreshing.'));
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }

  add(): void {
    if (this.busy() || this.editorLoading()) return;
    this.navigate(() => {
      this.clearEditor();
      this.draft.set({ name: '', scope: 'project', transport: 'http', url: '', enabled: true });
    });
  }

  select(server: AgentMcpServerEntry): void {
    if (this.busy() || this.editorLoading()) return;
    this.navigate(() => {
      this.clearEditor();
      this.selectedId.set(server.entryId);
    });
  }

  edit(server: AgentMcpServerEntry): void {
    if (this.busy() || this.editorLoading()) return;
    this.navigate(() => void this.openEditor(server));
  }

  private async openEditor(server: AgentMcpServerEntry): Promise<void> {
    this.clearEditor();
    this.selectedId.set(server.entryId);
    const version = ++this.version;
    this.loading.set(false);
    this.canceled.next();
    this.editorLoading.set(true);
    this.error.set(null);
    try {
      const result = await this.read(
        this.api.getMcpServerDefinition(this.sessionId(), server.entryId),
      );
      if (version === this.version) {
        this.editingId.set(server.entryId);
        this.draft.set(result);
      }
    } catch (error) {
      if (version === this.version)
        this.error.set(getHttpErrorMessage(error, 'Could not open this server.'));
    } finally {
      if (version === this.version) this.editorLoading.set(false);
    }
  }

  cancelEditor(after?: () => void): void {
    if (this.busy()) return;
    this.navigate(() => {
      this.clearEditor();
      after?.();
    });
  }

  keepEditing(): void {
    this.pendingNavigation = null;
    this.discardPending.set(false);
  }

  discardChanges(): void {
    const next = this.pendingNavigation;
    this.clearEditor();
    next?.();
  }

  private navigate(next: () => void): void {
    if (this.draft() && this.editorDirty()) {
      this.pendingNavigation = next;
      this.discardPending.set(true);
    } else next();
  }

  private clearEditor(): void {
    if (this.editorLoading()) {
      this.version++;
      this.canceled.next();
      this.editorLoading.set(false);
    }
    this.draft.set(null);
    this.editingId.set(undefined);
    this.error.set(null);
    this.editorDirty.set(false);
    this.keepEditing();
  }

  save(definition: McpServerDefinition): void {
    const editingId = this.editingId();
    void this.mutate(
      'save',
      () => this.api.saveMcpServer(this.sessionId(), definition, this.editingId()),
      () => {
        const saved = this.snapshot()?.servers.find((server) =>
          editingId
            ? server.entryId === editingId
            : server.name === definition.name && server.scope === definition.scope,
        );
        if (saved) this.selectedId.set(saved.entryId);
        this.clearEditor();
      },
    );
  }
  remove(server: AgentMcpServerEntry): void {
    void this.mutate(
      server.entryId,
      () => this.api.removeMcpServer(this.sessionId(), server.entryId, server.revision!),
      undefined,
      'remove',
    );
  }
  toggle(server: AgentMcpServerEntry): void {
    void this.mutate(
      server.entryId,
      () => this.api.toggleMcpServer(this.sessionId(), server.entryId),
      undefined,
      'toggle',
    );
  }
  check(server: AgentMcpServerEntry): void {
    void this.mutate(
      server.entryId,
      () => this.api.recheckMcpServer(this.sessionId(), server.entryId),
      undefined,
      'check',
    );
  }
  reload(): void {
    void this.mutate(
      'reload',
      () => this.api.reloadMcpConfiguration(this.sessionId()),
      undefined,
      'reload',
    );
  }
  async authenticate(server: AgentMcpServerEntry): Promise<void> {
    if (this.busy()) return;
    const version = ++this.version;
    this.canceled.next();
    this.loading.set(false);
    this.busy.set(server.entryId);
    this.operation.set('auth');
    this.error.set(null);
    try {
      const result = await this.read(this.api.startMcpAuth(this.sessionId(), server.entryId));
      if (version === this.version)
        this.authorization.next({ url: result.url, message: result.message });
    } catch (error) {
      if (version === this.version)
        this.error.set(getHttpErrorMessage(error, 'Could not start authentication.'));
    } finally {
      if (version === this.version) {
        this.busy.set(null);
        this.operation.set(null);
      }
    }
  }

  private async mutate(
    key: string,
    request: () => Observable<AgentMcpSnapshot>,
    applied?: () => void,
    operation: McpOperation = 'save',
  ): Promise<void> {
    if (this.busy()) return;
    const version = ++this.version;
    this.canceled.next();
    this.loading.set(false);
    this.busy.set(key);
    this.operation.set(operation);
    this.error.set(null);
    try {
      const result = await this.read(request());
      if (version === this.version) {
        this.applySnapshot(result);
        applied?.();
      }
    } catch (error) {
      if (version === this.version)
        this.error.set(getHttpErrorMessage(error, 'Could not update MCP configuration.'));
    } finally {
      if (version === this.version) {
        this.busy.set(null);
        this.operation.set(null);
      }
    }
  }

  private read<T>(request: Observable<T>): Promise<T> {
    return firstValueFrom(
      request.pipe(
        timeout({ first: 35_000 }),
        takeUntil(this.canceled),
        takeUntilDestroyed(this.destroyRef),
      ),
    );
  }

  private applySnapshot(snapshot: AgentMcpSnapshot): void {
    this.snapshot.set(snapshot);
    if (!snapshot.servers.some((server) => server.entryId === this.selectedId()))
      this.selectedId.set(snapshot.servers[0]?.entryId ?? null);
  }
}
