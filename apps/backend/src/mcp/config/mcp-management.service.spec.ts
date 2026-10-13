import type { McpSnapshot } from '../mcp.types.js';
import { atPath } from './mcp-config.types.js';
jest.mock('../../opencode-runtime/opencode-version.js', () => ({
  resolveOpenCodeBinary: jest.fn().mockResolvedValue('opencode'),
  openCodeMajorVersion: jest.fn().mockResolvedValue(1),
}));
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { McpManagementService } from './mcp-management.service.js';
import { McpConfigFileService } from './mcp-config-file.service.js';
import { openCodeMajorVersion } from '../../opencode-runtime/opencode-version.js';
import { configSources } from './mcp-config-adapters.js';
import type { McpProvider, McpServerDefinition } from './mcp-config.types.js';
import type { SessionsService } from '../../sessions/sessions.service.js';
import type { AgentRuntimeRegistryService } from '../../agent-runtime/agent-runtime-registry.service.js';

jest.mock('../../sessions/sessions.service.js', () => ({
  SessionsService: class {},
}));
jest.mock('../../agent-runtime/agent-runtime-registry.service.js', () => ({
  AgentRuntimeRegistryService: class {},
}));

const empty = (): McpSnapshot => ({
  servers: [],
  diagnostics: [],
  summary: {
    total: 0,
    connected: 0,
    failed: 0,
    disabled: 0,
    needsAuth: 0,
    malformed: 0,
  },
  lastUpdatedAt: new Date().toISOString(),
});

describe('MCP configuration manager', () => {
  let directory: string;
  let cwd: string;
  let manager: McpManagementService;
  let files: McpConfigFileService;
  const originalEnv = { ...process.env };
  const runtime = {
    getMcpSnapshot: jest.fn(),
    reloadMcpConfiguration: jest.fn(),
    recheckMcpServer: jest.fn(),
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'elevenex-mcp-test-'));
    cwd = join(directory, 'project');
    await fs.mkdir(cwd);
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude');
    process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = join(directory, 'managed');
    process.env.CODEX_HOME = join(directory, 'codex');
    process.env.OPENCODE_CONFIG_DIR = join(directory, 'opencode');
    process.env.XDG_CONFIG_HOME = join(directory, 'xdg');
    delete process.env.OPENCODE_CONFIG;
    process.env.PI_CODING_AGENT_DIR = join(directory, 'pi');
    runtime.getMcpSnapshot.mockReset().mockResolvedValue(empty());
    runtime.reloadMcpConfiguration.mockReset().mockResolvedValue(undefined);
    jest.mocked(openCodeMajorVersion).mockResolvedValue(1);
    files = new McpConfigFileService();
    manager = new McpManagementService(
      {
        findOne: () => Promise.resolve({ worktreePath: cwd }),
      } as unknown as SessionsService,
      {
        getProvider: () => runtime,
        getProviderFeature: () => runtime,
      } as unknown as AgentRuntimeRegistryService,
      files,
    );
  });
  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each<McpProvider>(['claude', 'codex', 'opencode', 'pi'])(
    'creates, edits, disables, reloads, and removes a %s server',
    async (provider) => {
      const definition: McpServerDefinition = {
        name: 'docs',
        scope: 'project',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'a package'],
        env: { TOKEN: 'secret' },
        enabled: true,
      };
      const created = await manager.save(1, provider, definition);
      const server = created.servers.find((s) => s.name === 'docs')!;
      expect(server.actions.canEdit).toBe(true);
      expect(created.reloadRequired).toBe(true);
      expect(JSON.stringify(created)).not.toContain('secret');
      const editable = await manager.getDefinition(1, provider, server.entryId);
      expect(editable.env).toEqual({ TOKEN: 'secret' });
      await manager.save(
        1,
        provider,
        { ...editable, command: 'node', args: ['server.js'] },
        server.entryId,
      );
      const disabled = await manager.toggle(1, provider, server.entryId);
      const entry = disabled.servers.find((s) => s.entryId === server.entryId)!;
      expect(entry.enabled).toBe(false);
      expect(entry.connectionStatus).toBe('disabled');
      const source = configSources(provider, cwd).find(
        (s) => s.scope === 'project',
      )!;
      const content = await fs.readFile(source.path, 'utf8');
      const root: unknown =
        provider === 'codex' ? parse(content) : JSON.parse(content);
      if (provider === 'codex')
        expect(atPath(root, ['mcp_servers', 'docs', 'enabled'])).toBe(false);
      if (provider === 'claude') {
        expect(atPath(root, ['projects'])).toBeUndefined();
        const global: unknown = JSON.parse(
          await fs.readFile(configSources(provider, cwd)[0].path, 'utf8'),
        );
        expect(atPath(global, ['projects', cwd, 'disabledMcpServers'])).toEqual(
          ['docs'],
        );
      }
      expect((await manager.reload(1, provider)).reloadRequired).toBe(false);
      expect(runtime.reloadMcpConfiguration).toHaveBeenCalledWith(1);
      await manager.remove(1, provider, entry.entryId, entry.revision!);
      expect((await manager.getSnapshot(1, provider)).servers).toHaveLength(0);
    },
  );

  it('uses exact scope identities when server names overlap', async () => {
    await manager.save(1, 'codex', {
      name: 'same',
      scope: 'user',
      transport: 'http',
      url: 'https://example.com/user',
    });
    const snapshot = await manager.save(1, 'codex', {
      name: 'same',
      scope: 'project',
      transport: 'http',
      url: 'https://example.com/project',
    });
    const project = snapshot.servers.find((s) => s.scope === 'project')!;
    expect(snapshot.servers.find((s) => s.scope === 'user')!.shadowed).toBe(
      true,
    );
    await expect(manager.toggle(1, 'codex', 'same')).rejects.toThrow(
      'Several scopes',
    );
    await manager.toggle(1, 'codex', project.entryId);
    const after = await manager.getSnapshot(1, 'codex');
    expect(after.servers.find((s) => s.scope === 'user')!.enabled).toBe(true);
    expect(after.servers.find((s) => s.scope === 'project')!.enabled).toBe(
      false,
    );
  });

  it('honors Claude enabled overrides and can disable a server present in both lists', async () => {
    const created = await manager.save(1, 'claude', {
      name: 'docs',
      scope: 'project',
      transport: 'http',
      url: 'https://example.com',
    });
    const path = configSources('claude', cwd)[0].path;
    await fs.writeFile(
      path,
      JSON.stringify({
        projects: {
          [cwd]: { enabledMcpServers: ['docs'], disabledMcpServers: ['docs'] },
        },
      }),
    );
    expect((await manager.getSnapshot(1, 'claude')).servers[0].enabled).toBe(
      true,
    );
    expect(
      (await manager.toggle(1, 'claude', created.servers[0].entryId)).servers[0]
        .enabled,
    ).toBe(false);
  });

  it('repairs the old Codex disabled flag while reflecting native enabled state', async () => {
    const source = configSources('codex', cwd)[1];
    await fs.mkdir(join(cwd, '.codex'));
    await fs.writeFile(
      source.path,
      '[mcp_servers.docs]\ncommand = "node"\ndisabled = true\n',
    );
    const entry = (await manager.getSnapshot(1, 'codex')).servers[0];
    expect(entry.enabled).toBe(true);
    await manager.toggle(1, 'codex', entry.entryId);
    const root = parse(await fs.readFile(source.path, 'utf8'));
    expect(atPath(root, ['mcp_servers', 'docs', 'enabled'])).toBe(false);
    expect(atPath(root, ['mcp_servers', 'docs', 'disabled'])).toBeUndefined();
  });

  it('preserves TOML comments and unrelated settings, including quoted server names and nested options', async () => {
    const source = configSources('codex', cwd)[1];
    await fs.mkdir(join(cwd, '.codex'));
    await fs.writeFile(
      source.path,
      '# Keep this header\nmodel = "custom"\n\n[mcp_servers."my.docs"]\ncommand = "node"\nstartup_timeout_sec = 25\n[mcp_servers."my.docs".env]\nTOKEN = "secret"\n\n[features]\n# Keep this feature\nfast = true\n',
    );
    const snapshot = await manager.getSnapshot(1, 'codex');
    const entry = snapshot.servers[0];
    const definition = await manager.getDefinition(1, 'codex', entry.entryId);
    await manager.save(
      1,
      'codex',
      { ...definition, command: 'npx' },
      entry.entryId,
    );
    const text = await fs.readFile(source.path, 'utf8');
    expect(text).toContain('# Keep this header');
    expect(text).toContain('# Keep this feature');
    expect(parse(text).mcp_servers['my.docs']).toMatchObject({
      command: 'npx',
      startup_timeout_sec: 25,
      env: { TOKEN: 'secret' },
    });
  });

  it('preserves OpenCode JSONC comments and supports the v2 server collection', async () => {
    const path = join(cwd, 'opencode.jsonc');
    await fs.writeFile(
      path,
      '{\n// Keep my model\n"model": "custom",\n"mcp": {"servers": {"docs": {"type":"remote","url":"https://example.com","disabled":false,"timeout":12000}}},\n}',
    );
    const entry = (await manager.getSnapshot(1, 'opencode')).servers[0];
    await manager.toggle(1, 'opencode', entry.entryId);
    const text = await fs.readFile(path, 'utf8');
    expect(text).toContain('// Keep my model');
    const source = configSources('opencode', cwd).find((s) => s.path === path)!;
    expect((await files.read(source)).root.mcp).toEqual({
      servers: {
        docs: {
          type: 'remote',
          url: 'https://example.com',
          disabled: true,
          timeout: 12000,
        },
      },
    });
  });

  it('creates the native v2 collection when OpenCode v2 is installed', async () => {
    jest.mocked(openCodeMajorVersion).mockResolvedValue(2);
    await manager.save(1, 'opencode', {
      name: 'docs',
      scope: 'project',
      transport: 'http',
      url: 'https://example.com',
    });
    const root: unknown = JSON.parse(
      await fs.readFile(join(cwd, 'opencode.json'), 'utf8'),
    );
    expect(atPath(root, ['mcp', 'servers', 'docs'])).toMatchObject({
      type: 'remote',
      disabled: false,
    });
    expect(atPath(root, ['mcp', 'docs'])).toBeUndefined();
  });

  it('preserves symbolic links to native configuration', async () => {
    const target = join(directory, 'dotfiles.json');
    await fs.writeFile(target, '{"mcpServers":{"docs":{"command":"node"}}}');
    await fs.mkdir(join(cwd, '.pi'));
    await fs.symlink(target, join(cwd, '.pi', 'mcp.json'));
    const entry = (await manager.getSnapshot(1, 'pi')).servers[0];
    await manager.toggle(1, 'pi', entry.entryId);
    expect(
      (await fs.lstat(join(cwd, '.pi', 'mcp.json'))).isSymbolicLink(),
    ).toBe(true);
    expect(
      atPath(JSON.parse(await fs.readFile(target, 'utf8')) as unknown, [
        'mcpServers',
        'docs',
        'enabled',
      ]),
    ).toBe(false);
  });

  it('detects external file edits and keeps the reload notice until applied', async () => {
    await manager.save(1, 'pi', {
      name: 'docs',
      scope: 'project',
      transport: 'http',
      url: 'https://example.com',
    });
    await manager.reload(1, 'pi');
    const path = join(cwd, '.pi', 'mcp.json');
    const root = JSON.parse(await fs.readFile(path, 'utf8')) as {
      mcpServers: { docs: { url: string } };
    };
    root.mcpServers.docs.url = 'https://changed.example.com';
    await fs.writeFile(path, JSON.stringify(root));
    expect((await manager.getSnapshot(1, 'pi')).reloadRequired).toBe(true);
    expect((await manager.getSnapshot(1, 'pi')).reloadRequired).toBe(true);
  });

  it('rejects stale edits and removals', async () => {
    const created = await manager.save(1, 'pi', {
      name: 'docs',
      scope: 'project',
      transport: 'http',
      url: 'https://example.com',
    });
    const entry = created.servers[0];
    const definition = await manager.getDefinition(1, 'pi', entry.entryId);
    await manager.toggle(1, 'pi', entry.entryId);
    await expect(
      manager.save(1, 'pi', definition, entry.entryId),
    ).rejects.toThrow('changed elsewhere');
    await expect(
      manager.remove(1, 'pi', entry.entryId, entry.revision!),
    ).rejects.toThrow('changed elsewhere');
  });

  it('does not overwrite malformed native configuration', async () => {
    const path = join(cwd, '.mcp.json');
    await fs.writeFile(path, '{ broken');
    const snapshot = await manager.getSnapshot(1, 'claude');
    expect(snapshot.diagnostics).toHaveLength(1);
    await expect(
      manager.save(1, 'claude', {
        name: 'docs',
        scope: 'project',
        transport: 'http',
        url: 'https://example.com',
      }),
    ).rejects.toThrow('Fix its syntax');
    expect(await fs.readFile(path, 'utf8')).toBe('{ broken');
  });

  it('does not corrupt a sealed inline TOML server collection', async () => {
    const source = configSources('codex', cwd)[1];
    await fs.mkdir(join(cwd, '.codex'));
    const original =
      'model = "custom"\nmcp_servers = { old = { command = "node" } }\n';
    await fs.writeFile(source.path, original);
    await expect(
      manager.save(1, 'codex', {
        name: 'docs',
        scope: 'project',
        transport: 'http',
        url: 'https://example.com',
      }),
    ).rejects.toThrow('inline');
    expect(await fs.readFile(source.path, 'utf8')).toBe(original);
  });

  it('serializes concurrent writes without losing servers', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        manager.save(1, 'pi', {
          name: `docs-${index}`,
          scope: 'project',
          transport: 'http',
          url: 'https://example.com',
        }),
      ),
    );
    expect((await manager.getSnapshot(1, 'pi')).servers).toHaveLength(12);
  });

  it('manual refresh waits for current inventory and coalesces the pending provider request', async () => {
    await fs.mkdir(join(cwd, '.pi'));
    await fs.writeFile(
      join(cwd, '.pi', 'mcp.json'),
      '{"mcpServers":{"docs":{"url":"https://example.com"}}}',
    );
    let resolveInventory!: (value: ReturnType<typeof empty>) => void;
    runtime.getMcpSnapshot.mockImplementation(
      () =>
        new Promise<ReturnType<typeof empty>>((resolve) => {
          resolveInventory = resolve;
        }),
    );
    expect(
      (await manager.getSnapshot(1, 'pi')).servers[0].connectionStatus,
    ).toBe('unknown');
    const refreshing = manager.getSnapshot(1, 'pi', true);
    resolveInventory({
      ...empty(),
      servers: [
        {
          entryId: 'runtime-docs',
          name: 'docs',
          scope: 'runtime',
          transport: 'http',
          configLocation: 'runtime',
          enabled: true,
          connectionStatus: 'connected',
          configStatus: 'valid',
          actions: {
            canToggle: false,
            canRecheck: false,
            canAuth: false,
            canReauth: false,
            canViewTools: false,
          },
        },
      ],
    });
    expect((await refreshing).servers[0].connectionStatus).toBe('connected');
    expect(runtime.getMcpSnapshot).toHaveBeenCalledTimes(1);
  });

  it('returns configuration immediately when a provider never responds and coalesces inventory reads', async () => {
    runtime.getMcpSnapshot.mockImplementation(
      () => new Promise(() => undefined),
    );
    const snapshots = await Promise.all(
      Array.from({ length: 10 }, () => manager.getSnapshot(1, 'opencode')),
    );
    expect(snapshots[0].provider).toBe('opencode');
    expect(runtime.getMcpSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each([
    'file:///tmp/test',
    'javascript:alert(1)',
    'https://user:pass@example.com',
  ])('rejects invalid remote URL %s', async (url) => {
    await expect(
      manager.save(1, 'pi', {
        name: 'docs',
        scope: 'project',
        transport: 'http',
        url,
      }),
    ).rejects.toThrow('HTTP or HTTPS');
  });

  it.each(['"""', "'''"])(
    'preserves table-like text inside %s TOML strings',
    async (quotes) => {
      const source = configSources('codex', cwd)[1];
      await fs.mkdir(join(cwd, '.codex'));
      const original = `instructions = ${quotes}\n[mcp_servers.docs]\nPreserve this example.\n[example]\nOther example.\n${quotes}\n\n[mcp_servers.docs]\ncommand = "node"\n`;
      await fs.writeFile(source.path, original);
      const entry = (await manager.getSnapshot(1, 'codex')).servers[0];
      await manager.toggle(1, 'codex', entry.entryId);
      expect(
        parse(await fs.readFile(source.path, 'utf8')).instructions,
      ).toEqual(parse(original).instructions);
    },
  );

  it('does not treat nested arrays as TOML table boundaries', async () => {
    const source = configSources('codex', cwd)[1];
    await fs.mkdir(join(cwd, '.codex'));
    await fs.writeFile(
      source.path,
      'examples = [\n[1],\n[2]\n]\n[mcp_servers.docs]\ncommand = "node"\n',
    );
    const entry = (await manager.getSnapshot(1, 'codex')).servers[0];
    await manager.toggle(1, 'codex', entry.entryId);
    expect(parse(await fs.readFile(source.path, 'utf8')).examples).toEqual([
      [1],
      [2],
    ]);
  });

  it('lets project OpenCode settings override a custom config file', async () => {
    const custom = join(directory, 'custom.json');
    process.env.OPENCODE_CONFIG = custom;
    await fs.writeFile(
      custom,
      '{"mcp":{"docs":{"type":"remote","url":"https://custom.example.com"}}}',
    );
    await fs.writeFile(
      join(cwd, 'opencode.json'),
      '{"mcp":{"docs":{"type":"remote","url":"https://project.example.com"}}}',
    );
    const snapshot = await manager.getSnapshot(1, 'opencode');
    expect(
      snapshot.servers.find((s) => s.name === 'docs' && !s.shadowed),
    ).toMatchObject({
      scope: 'project',
      endpoint: 'https://project.example.com/',
    });
  });

  it('reads OpenCode globals alongside the custom configuration directory', async () => {
    await fs.mkdir(join(process.env.XDG_CONFIG_HOME!, 'opencode'), {
      recursive: true,
    });
    await fs.mkdir(process.env.OPENCODE_CONFIG_DIR!, { recursive: true });
    await fs.writeFile(
      join(process.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'),
      '{"mcp":{"global":{"command":["node"],"type":"local"}}}',
    );
    await fs.writeFile(
      join(process.env.OPENCODE_CONFIG_DIR!, 'opencode.json'),
      '{"mcp":{"custom":{"command":["node"],"type":"local"}}}',
    );
    expect(
      (await manager.getSnapshot(1, 'opencode')).servers.map((s) => s.name),
    ).toEqual(['global', 'custom']);
  });

  it('reads a shared Claude configuration file once per inventory', async () => {
    const read = jest.spyOn(files, 'read');
    await manager.getSnapshot(1, 'claude');
    expect(
      read.mock.calls.filter(
        ([source]) => source.path === configSources('claude', cwd)[0].path,
      ),
    ).toHaveLength(1);
  });

  it('persists imported native options across subsequent edits', async () => {
    const created = await manager.save(1, 'opencode', {
      name: 'docs',
      scope: 'project',
      transport: 'http',
      url: 'https://example.com',
      nativeOptions: { oauth: false, timeout: 12000 },
    });
    const entry = created.servers.find((s) => s.name === 'docs')!;
    const definition = await manager.getDefinition(
      1,
      'opencode',
      entry.entryId,
    );
    await manager.save(
      1,
      'opencode',
      { ...definition, url: 'https://changed.example.com' },
      entry.entryId,
    );
    const source = configSources('opencode', cwd).find(
      (s) => s.scope === 'project',
    )!;
    expect(
      atPath((await files.read(source)).root, ['mcp', 'docs']),
    ).toMatchObject({
      oauth: false,
      timeout: 12000,
      url: 'https://changed.example.com',
    });
  });

  it.each([
    { command: 'bypass' },
    { oauth: { constructor: 'reserved' } },
    { timeout: Number.NaN },
  ])('rejects unsafe native options %j', async (nativeOptions) => {
    await expect(
      manager.save(1, 'pi', {
        name: 'docs',
        scope: 'project',
        transport: 'stdio',
        command: 'node',
        nativeOptions,
      }),
    ).rejects.toThrow();
  });
});
