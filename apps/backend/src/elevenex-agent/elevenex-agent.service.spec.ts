import { mkdtemp, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ElevenexAgentService } from './elevenex-agent.service.js';

describe('ElevenexAgentService', () => {
  let service: ElevenexAgentService;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evx-agent-'));
    // ensureWorkspace() (the unit under test) only touches the filesystem, so the
    // Projects/Repos deps can be stubbed — ensureAgentRepo is covered elsewhere.
    service = new ElevenexAgentService(
      {} as never, // ProjectsService
      {} as never, // ReposService
    );
    // Point the workspace at a temp dir.
    jest.spyOn(service, 'workspaceDir', 'get').mockReturnValue(dir);
  });

  it('writes a .mcp.json with an http elevenex server using token expansion', async () => {
    await service.ensureWorkspace();
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.elevenex.type).toBe('http');
    expect(mcp.mcpServers.elevenex.url).toContain('/api/mcp');
    expect(mcp.mcpServers.elevenex.headers.Authorization).toBe(
      'Bearer ${ELEVENEX_AGENT_TOKEN}',
    );
  });

  it('auto-allows the safe read-only tools in settings.local.json', async () => {
    await service.ensureWorkspace();
    const settings = JSON.parse(
      await readFile(join(dir, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.permissions.allow).toContain(
      'mcp__elevenex__project_overview',
    );
    expect(settings.permissions.allow).toContain('mcp__elevenex__read_session');
    // Mutating/destructive tools must NOT be auto-allowed.
    expect(settings.permissions.allow).not.toContain(
      'mcp__elevenex__steal_worktree',
    );
  });

  it('merges into existing config without clobbering user keys', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { type: 'stdio' } } }),
    );
    await writeFile(
      join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash'] } }),
    );

    await service.ensureWorkspace();

    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.other).toBeDefined();
    expect(mcp.mcpServers.elevenex).toBeDefined();

    const settings = JSON.parse(
      await readFile(join(dir, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(settings.theme).toBe('dark');
    expect(settings.permissions.allow).toContain('Bash');
    expect(settings.permissions.allow).toContain(
      'mcp__elevenex__project_overview',
    );
  });
});
