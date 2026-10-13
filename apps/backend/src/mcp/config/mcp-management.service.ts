import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SessionsService } from '../../sessions/sessions.service.js';
import { AgentRuntimeRegistryService } from '../../agent-runtime/agent-runtime-registry.service.js';
import type { McpSnapshot } from '../mcp.types.js';
import {
  configSources,
  decodeConfig,
  encodeConfig,
  serverPath,
  validateDefinition,
} from './mcp-config-adapters.js';
import { McpConfigFileService, revision } from './mcp-config-file.service.js';
import {
  atPath,
  strings,
  record,
  type McpConfigRecord,
  type McpConfigSource,
  type McpManagedEntry,
  type McpManagedSnapshot,
  type McpProvider,
  type McpServerDefinition,
} from './mcp-config.types.js';
import {
  openCodeMajorVersion,
  resolveOpenCodeBinary,
} from '../../opencode-runtime/opencode-version.js';

interface ConfigEntry {
  source: McpConfigSource;
  name: string;
  config: McpConfigRecord;
  root: McpConfigRecord;
  id: string;
}

@Injectable()
export class McpManagementService {
  private readonly reads = new Map<string, Promise<McpManagedSnapshot>>();
  private readonly pendingReload = new Set<string>();
  private readonly runtimeReads = new Map<string, Promise<void>>();
  private readonly runtimeCache = new Map<
    string,
    { snapshot: McpSnapshot; checkedAt: number }
  >();
  private readonly configVersions = new Map<string, string>();

  constructor(
    private readonly sessions: SessionsService,
    private readonly registry: AgentRuntimeRegistryService,
    private readonly files: McpConfigFileService,
  ) {}

  private provider(id: string): McpProvider {
    this.registry.getProvider(id);
    if (!['claude', 'codex', 'opencode', 'pi'].includes(id))
      throw new BadRequestException(
        'MCP configuration is unavailable for this agent.',
      );
    return id as McpProvider;
  }

  private key(sessionId: number, provider: string): string {
    return `${provider}:${sessionId}`;
  }
  private id(
    provider: McpProvider,
    source: McpConfigSource,
    name: string,
  ): string {
    return `${provider}:${source.scope}:${revision(source.path).slice(0, 12)}:${name}`;
  }

  private async configs(sessionId: number, provider: McpProvider) {
    const session = await this.sessions.findOne(sessionId);
    const sources = configSources(provider, session.worktreePath);
    const entries: ConfigEntry[] = [];
    const diagnostics: McpManagedSnapshot['diagnostics'] = [];
    // Claude user/local scopes share one file. Read each physical source once
    // per inventory, while retaining scope-specific diagnostics and precedence.
    const fileReads = new Map<
      string,
      ReturnType<McpConfigFileService['read']>
    >();
    const loaded = await Promise.all(
      sources.map(async (source) => {
        try {
          let read = fileReads.get(source.path);
          if (!read) {
            read = this.files.read(source);
            fileReads.set(source.path, read);
          }
          return { source, ...(await read) };
        } catch (error) {
          diagnostics.push({
            scope: source.scope,
            configLocation: source.path,
            errors: [
              {
                message:
                  error instanceof Error
                    ? error.message
                    : 'Could not read configuration.',
              },
            ],
            warnings: [],
          });
          return { source, raw: '', root: null };
        }
      }),
    );
    for (const { source, root } of loaded) {
      if (!root) continue;
      const servers = atPath(root, serverPath(source, root, provider));
      if (servers !== undefined && !record(servers)) {
        diagnostics.push({
          scope: source.scope,
          configLocation: source.path,
          errors: [{ message: 'The MCP server collection must be an object.' }],
          warnings: [],
        });
        continue;
      }
      for (const [name, config] of Object.entries(record(servers) ?? {}))
        entries.push({
          source,
          name,
          root,
          config: record(config) ?? {},
          id: this.id(provider, source, name),
        });
    }
    return { entries, diagnostics, loaded, cwd: session.worktreePath };
  }

  getSnapshot(
    sessionId: number,
    providerId: string,
    forceRefresh = false,
  ): Promise<McpManagedSnapshot> {
    const provider = this.provider(providerId);
    const key = this.key(sessionId, provider);
    const readKey = forceRefresh ? `${key}:refresh` : key;
    const existing = this.reads.get(readKey);
    if (existing) return existing;
    const pending = (async () => {
      if (forceRefresh) {
        this.runtimeSnapshot(sessionId, provider, true);
        const inventory = this.runtimeReads.get(key);
        if (inventory) {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              inventory,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 1_500);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
      return this.snapshot(sessionId, provider);
    })().finally(() => {
      if (this.reads.get(readKey) === pending) this.reads.delete(readKey);
    });
    this.reads.set(readKey, pending);
    return pending;
  }

  private async snapshot(
    sessionId: number,
    provider: McpProvider,
  ): Promise<McpManagedSnapshot> {
    const runtime = this.runtimeSnapshot(sessionId, provider);
    const { entries, diagnostics, cwd, loaded } = await this.configs(
      sessionId,
      provider,
    );
    const effective = new Map<string, ConfigEntry>();
    for (const entry of entries) effective.set(entry.name, entry);
    const liveServers = new Map<
      string,
      Map<string, McpSnapshot['servers'][number]>
    >();
    const liveEnabled = new Set<string>();
    for (const server of runtime?.servers ?? []) {
      let scopes = liveServers.get(server.name);
      if (!scopes) {
        scopes = new Map();
        liveServers.set(server.name, scopes);
      }
      if (!scopes.has(server.scope)) scopes.set(server.scope, server);
      if (server.enabled) liveEnabled.add(server.name);
    }
    const managedNames = new Set(
      runtime?.servers
        .filter(
          (server) => server.origin === 'sdk' || server.origin === 'plugin',
        )
        .map((server) => server.name),
    );
    const key = this.key(sessionId, provider);
    const fingerprint = revision({
      servers: entries.map((entry) => ({ id: entry.id, config: entry.config })),
      enabled: atPath(loaded[0]?.root, ['projects', cwd, 'enabledMcpServers']),
      disabled: atPath(loaded[0]?.root, [
        'projects',
        cwd,
        'disabledMcpServers',
      ]),
    });
    const previousVersion = this.configVersions.get(key);
    if (previousVersion && previousVersion !== fingerprint)
      this.pendingReload.add(key);
    if (this.configVersions.size >= 500 && !this.configVersions.has(key)) {
      for (const oldest of this.configVersions.keys()) {
        this.configVersions.delete(oldest);
        this.pendingReload.delete(oldest);
        this.runtimeCache.delete(oldest);
        break;
      }
    }
    this.configVersions.set(key, fingerprint);
    // A disabled definition must not appear applied while the actual agent
    // still reports an enabled connection, including another session's edits.
    for (const entry of effective.values()) {
      if (!entry.source.writable || managedNames.has(entry.name)) continue;
      const disabled =
        provider === 'claude'
          ? !strings(
              atPath(loaded[0]?.root, ['projects', cwd, 'enabledMcpServers']),
            ).includes(entry.name) &&
            strings(
              atPath(loaded[0]?.root, ['projects', cwd, 'disabledMcpServers']),
            ).includes(entry.name)
          : decodeConfig(
              provider,
              entry.name,
              entry.source.scope as McpServerDefinition['scope'],
              entry.config,
            ).enabled === false;
      if (disabled && liveEnabled.has(entry.name)) this.pendingReload.add(key);
    }
    const servers: McpManagedEntry[] = entries.map((entry) => {
      const definition = decodeConfig(
        provider,
        entry.name,
        entry.source.scope as McpServerDefinition['scope'],
        entry.config,
      );
      const disabled = atPath(loaded[0]?.root, [
        'projects',
        cwd,
        'disabledMcpServers',
      ]);
      const allowed = atPath(loaded[0]?.root, [
        'projects',
        cwd,
        'enabledMcpServers',
      ]);
      const enabled =
        provider === 'claude'
          ? strings(allowed).includes(entry.name) ||
            !strings(disabled).includes(entry.name)
          : definition.enabled !== false;
      const shadowed =
        managedNames.has(entry.name) || effective.get(entry.name) !== entry;
      const live =
        !shadowed && !this.pendingReload.has(this.key(sessionId, provider))
          ? (liveServers.get(entry.name)?.get(entry.source.scope) ??
            liveServers.get(entry.name)?.get('runtime'))
          : undefined;
      const supported =
        definition.transport === 'stdio'
          ? typeof definition.command === 'string' &&
            !!definition.command.trim()
          : !!definition.url;
      const editable =
        entry.source.writable &&
        entry.name !== 'elevenex' &&
        !['sdk', 'ws', 'ws-ide', 'claudeai-proxy'].includes(
          String(entry.config.type),
        );
      const endpoint =
        definition.transport === 'stdio'
          ? definition.command
          : this.safeUrl(definition.url);
      return {
        ...live,
        entryId: entry.id,
        name: entry.name,
        scope: entry.source.scope,
        transport: definition.transport,
        configLocation: entry.source.path,
        enabled,
        endpoint,
        revision: revision(entry.config),
        shadowed,
        connectionStatus: !enabled
          ? 'disabled'
          : !supported
            ? 'failed'
            : shadowed
              ? 'unknown'
              : (live?.connectionStatus ?? 'unknown'),
        configStatus: supported ? 'valid' : 'error',
        error: supported ? live?.error : 'Configure a command or server URL.',
        actions: {
          canToggle: editable && !(provider === 'claude' && shadowed),
          canEdit: editable,
          canRemove: editable,
          canRecheck:
            enabled &&
            !shadowed &&
            supported &&
            provider !== 'pi' &&
            (live?.actions.canRecheck ?? true) &&
            (provider !== 'codex' || entry.source.scope === 'user' || !!live) &&
            !this.pendingReload.has(key),
          canAuth:
            !this.pendingReload.has(key) &&
            !shadowed &&
            enabled &&
            (live?.actions.canAuth ?? false),
          canReauth:
            !this.pendingReload.has(key) &&
            !shadowed &&
            enabled &&
            (live?.actions.canReauth ?? false),
          canViewTools: !!live?.tools?.length,
        },
      };
    });
    for (const live of this.pendingReload.has(this.key(sessionId, provider))
      ? []
      : (runtime?.servers ?? [])) {
      if (effective.has(live.name) && !managedNames.has(live.name)) continue;
      servers.push({
        ...live,
        actions: {
          ...live.actions,
          canToggle: false,
          canEdit: false,
          canRemove: false,
        },
      });
    }
    const summary = {
      connected: servers.filter(
        (s) => !s.shadowed && s.connectionStatus === 'connected',
      ).length,
      needsAuth: servers.filter(
        (s) => !s.shadowed && s.connectionStatus === 'needs-auth',
      ).length,
      failed: servers.filter(
        (s) => !s.shadowed && s.connectionStatus === 'failed',
      ).length,
      disabled: servers.filter((s) => !s.enabled).length,
      malformed:
        servers.filter((s) => s.configStatus === 'error').length +
        diagnostics.length,
      total: servers.length,
    };
    return {
      provider,
      servers,
      diagnostics,
      summary,
      lastUpdatedAt: new Date().toISOString(),
      availableScopes:
        provider === 'claude'
          ? ['project', 'local', 'user']
          : ['project', 'user'],
      availableTransports:
        provider === 'claude' || provider === 'pi'
          ? ['http', 'stdio', 'sse']
          : ['http', 'stdio'],
      reloadRequired: this.pendingReload.has(this.key(sessionId, provider)),
    };
  }

  private runtimeSnapshot(
    sessionId: number,
    provider: McpProvider,
    forceRefresh = false,
  ): McpSnapshot | null {
    const runtime = this.registry.getProvider(provider);
    if (!runtime.getMcpSnapshot) return null;
    const key = this.key(sessionId, provider);
    const cached = this.runtimeCache.get(key);
    if (
      (forceRefresh || !cached || Date.now() - cached.checkedAt > 2_000) &&
      !this.runtimeReads.has(key)
    ) {
      // Configuration renders immediately. Live inventory refreshes in the background,
      // with one request per session; a slow agent never blocks the manager.
      const pending = Promise.resolve()
        .then(() => runtime.getMcpSnapshot!(sessionId, false))
        .then((snapshot) => {
          if (this.runtimeReads.get(key) !== pending) return;
          if (this.runtimeCache.size >= 200) {
            for (const oldest of this.runtimeCache.keys()) {
              this.runtimeCache.delete(oldest);
              break;
            }
          }
          this.runtimeCache.set(key, {
            snapshot,
            checkedAt: Date.now(),
          });
        })
        .catch(() => undefined)
        .finally(() => {
          if (this.runtimeReads.get(key) === pending)
            this.runtimeReads.delete(key);
        });
      this.runtimeReads.set(key, pending);
    }
    return cached?.snapshot ?? null;
  }

  private safeUrl(value?: string): string | undefined {
    try {
      const url = new URL(value!);
      return `${url.origin}${url.pathname}`;
    } catch {
      return undefined;
    }
  }

  private async find(
    sessionId: number,
    provider: McpProvider,
    id: string,
  ): Promise<ConfigEntry> {
    const { entries } = await this.configs(sessionId, provider);
    const matches = entries.filter((e) => e.id === id || e.name === id);
    if (!matches.length)
      throw new NotFoundException(
        'MCP server no longer exists. Refresh the list.',
      );
    if (matches.length > 1)
      throw new ConflictException(
        'Several scopes contain this name. Select a specific server entry.',
      );
    const entry = matches[0];
    if (
      !entry.source.writable ||
      entry.name === 'elevenex' ||
      ['sdk', 'ws', 'ws-ide', 'claudeai-proxy'].includes(
        String(entry.config.type),
      )
    )
      throw new BadRequestException('This server is managed externally.');
    return entry;
  }

  async getDefinition(
    sessionId: number,
    providerId: string,
    id: string,
  ): Promise<McpServerDefinition> {
    const provider = this.provider(providerId);
    const entry = await this.find(sessionId, provider, id);
    const snapshot = await this.getSnapshot(sessionId, provider);
    return {
      ...decodeConfig(
        provider,
        entry.name,
        entry.source.scope as McpServerDefinition['scope'],
        entry.config,
      ),
      enabled: snapshot.servers.find((s) => s.entryId === entry.id)?.enabled,
      revision: revision(entry.config),
    };
  }

  async save(
    sessionId: number,
    providerId: string,
    value: McpServerDefinition,
    id?: string,
  ): Promise<McpManagedSnapshot> {
    const provider = this.provider(providerId);
    const definition = validateDefinition(value, provider);
    const { loaded, cwd, entries } = await this.configs(sessionId, provider);
    if (
      !id &&
      entries.some(
        (entry) =>
          entry.name === definition.name &&
          entry.source.scope === definition.scope,
      )
    )
      throw new ConflictException(
        'A server with this name already exists in this scope.',
      );
    const existing = id ? await this.find(sessionId, provider, id) : null;
    if (
      existing &&
      (existing.name !== definition.name ||
        existing.source.scope !== definition.scope)
    )
      throw new BadRequestException(
        'The name and scope of an existing server cannot be changed.',
      );
    const target =
      existing?.source ??
      loaded
        .filter((s) => s.source.scope === definition.scope && s.source.writable)
        .find((s) => s.raw || s.root === null)?.source ??
      loaded.find(
        (s) => s.source.scope === definition.scope && s.source.writable,
      )?.source;
    if (!target)
      throw new BadRequestException(
        'No writable configuration exists for this scope.',
      );
    const openCodeV2 =
      provider === 'opencode' &&
      (await resolveOpenCodeBinary()
        .then((binary) => openCodeMajorVersion(binary, cwd, process.env))
        .then((major) => major >= 2)
        .catch(() => false));
    if (provider === 'claude')
      await this.files.read(configSources(provider, cwd)[0]);
    await this.files.update(target, (root) => {
      const collection =
        provider === 'opencode' &&
        openCodeV2 &&
        (!record(root.mcp) || !Object.keys(record(root.mcp)!).length)
          ? ['mcp', 'servers']
          : serverPath(target, root, provider);
      const previous = atPath(root, [...collection, definition.name]);
      if (!id && previous !== undefined)
        throw new ConflictException(
          'A server with this name already exists in this scope.',
        );
      if (
        id &&
        (!definition.revision || revision(previous) !== definition.revision)
      )
        throw new ConflictException(
          'This server changed elsewhere. Reopen the editor before saving.',
        );
      const changes = [
        {
          path: [...collection, definition.name],
          value: encodeConfig(
            provider,
            definition,
            record(previous) ?? {},
            collection.length === 2 && provider === 'opencode',
          ),
        },
      ];
      return changes;
    });
    if (provider === 'claude')
      await this.files.update(configSources(provider, cwd)[0], (root) =>
        this.claudeEnabledChanges(
          root,
          cwd,
          definition.name,
          definition.enabled !== false,
        ),
      );
    return this.changed(sessionId, provider);
  }

  private claudeEnabledChanges(
    root: McpConfigRecord,
    cwd: string,
    name: string,
    enabled: boolean,
  ): { path: string[]; value: unknown }[] {
    const path = ['projects', cwd];
    const disabled = atPath(root, [...path, 'disabledMcpServers']);
    const allowed = atPath(root, [...path, 'enabledMcpServers']);
    return [
      {
        path: [...path, 'disabledMcpServers'],
        value: [
          ...new Set([
            ...strings(disabled).filter((n) => n !== name),
            ...(!enabled ? [name] : []),
          ]),
        ],
      },
      {
        path: [...path, 'enabledMcpServers'],
        value: strings(allowed).filter((n) => n !== name),
      },
    ];
  }

  async toggle(
    sessionId: number,
    providerId: string,
    id: string,
  ): Promise<McpManagedSnapshot> {
    const provider = this.provider(providerId);
    const entry = await this.find(sessionId, provider, id);
    if (provider === 'claude') {
      const { cwd, entries } = await this.configs(sessionId, provider);
      if (entries.filter((e) => e.name === entry.name).at(-1)?.id !== entry.id)
        throw new BadRequestException(
          'This server is overridden. Toggle the active definition instead.',
        );
      const target = configSources(provider, cwd)[0];
      await this.files.update(target, (root) => {
        const disabled = atPath(root, ['projects', cwd, 'disabledMcpServers']);
        const allowed = atPath(root, ['projects', cwd, 'enabledMcpServers']);
        return this.claudeEnabledChanges(
          root,
          cwd,
          entry.name,
          !strings(allowed).includes(entry.name) &&
            strings(disabled).includes(entry.name),
        );
      });
    } else
      await this.files.update(entry.source, (root) => {
        const path = [...serverPath(entry.source, root, provider), entry.name];
        const current = record(atPath(root, path));
        if (!current)
          throw new NotFoundException('MCP server no longer exists.');
        const enabled =
          current.enabled !== false &&
          (provider === 'codex' || current.disabled !== true);
        const next = { ...current };
        delete next.disabled;
        if (provider === 'opencode' && path.length === 3) {
          delete next.enabled;
          next.disabled = enabled;
        } else next.enabled = !enabled;
        return [{ path, value: next }];
      });
    return this.changed(sessionId, provider);
  }

  async remove(
    sessionId: number,
    providerId: string,
    id: string,
    expectedRevision: string,
  ): Promise<McpManagedSnapshot> {
    const provider = this.provider(providerId);
    const entry = await this.find(sessionId, provider, id);
    await this.files.update(entry.source, (root) => {
      const path = [...serverPath(entry.source, root, provider), entry.name];
      if (
        !expectedRevision ||
        revision(atPath(root, path)) !== expectedRevision
      )
        throw new ConflictException(
          'This server changed elsewhere. Refresh before removing it.',
        );
      return [{ path, value: undefined }];
    });
    return this.changed(sessionId, provider);
  }

  private async changed(
    sessionId: number,
    provider: McpProvider,
  ): Promise<McpManagedSnapshot> {
    // In-flight readers finish for their original callers; subsequent reads see the new file.
    this.reads.clear();
    this.pendingReload.add(this.key(sessionId, provider));
    const snapshot = await this.getSnapshot(sessionId, provider);
    return {
      ...snapshot,
      notice: 'Configuration saved. Reload tools to apply it to this session.',
    };
  }

  async reload(
    sessionId: number,
    providerId: string,
  ): Promise<McpManagedSnapshot> {
    const provider = this.provider(providerId);
    await this.registry
      .getProviderFeature(provider, 'reloadMcpConfiguration')
      .reloadMcpConfiguration(sessionId);
    this.pendingReload.delete(this.key(sessionId, provider));
    this.reads.delete(this.key(sessionId, provider));
    this.runtimeCache.delete(this.key(sessionId, provider));
    this.runtimeReads.delete(this.key(sessionId, provider));
    return this.getSnapshot(sessionId, provider);
  }

  async recheck(
    sessionId: number,
    providerId: string,
    id: string,
  ): Promise<McpManagedSnapshot> {
    const provider = this.provider(providerId);
    const snapshot = await this.getSnapshot(sessionId, provider);
    if (snapshot.reloadRequired)
      throw new BadRequestException(
        'Reload tools to apply the saved configuration first.',
      );
    const entry = snapshot.servers.find(
      (s) => s.entryId === id || s.name === id,
    );
    if (!entry || entry.shadowed || !entry.enabled || !entry.actions.canRecheck)
      throw new BadRequestException(
        'Select an enabled, active server to check.',
      );
    const checked = await this.registry
      .getProviderFeature(provider, 'recheckMcpServer')
      .recheckMcpServer(sessionId, entry.name, entry.scope);
    this.runtimeReads.delete(this.key(sessionId, provider));
    this.runtimeCache.set(this.key(sessionId, provider), {
      snapshot: checked,
      checkedAt: Date.now(),
    });
    this.reads.delete(this.key(sessionId, provider));
    return this.getSnapshot(sessionId, provider);
  }

  async startAuth(sessionId: number, providerId: string, id: string) {
    const provider = this.provider(providerId);
    const snapshot = await this.getSnapshot(sessionId, provider);
    if (snapshot.reloadRequired)
      throw new BadRequestException(
        'Reload tools to apply the saved configuration first.',
      );
    const entry = snapshot.servers.find(
      (s) => s.entryId === id || s.name === id,
    );
    if (
      !entry ||
      entry.shadowed ||
      !entry.enabled ||
      (!entry.actions.canAuth && !entry.actions.canReauth)
    )
      throw new BadRequestException(
        'Select an enabled, active server to authenticate.',
      );
    return this.registry
      .getProviderFeature(provider, 'startMcpAuth')
      .startMcpAuth(sessionId, entry.name, entry.scope);
  }
}
