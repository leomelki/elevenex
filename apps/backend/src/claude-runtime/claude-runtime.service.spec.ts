import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { homedir } from 'os';
import { join } from 'path';
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: jest.fn(),
  getSubagentMessages: jest.fn(),
  getSessionMessages: jest.fn(),
  query: jest.fn(),
}));
import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeRuntimeService,
  loadClaudeSdkPackageMetadata,
} from './claude-runtime.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { TerminalService } from '../terminal/terminal.service.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { SessionTitleService } from '../session-title/session-title.service.js';
import { SettingsService } from '../settings/settings.service.js';

function successfulResultMessage(sessionId = 'claude-session-1') {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: false,
    num_turns: 1,
    session_id: sessionId,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      server_tool_use: {
        web_search_requests: 0,
      },
    },
    result: 'Done',
    stop_reason: 'end_turn',
  };
}

function successfulResultIterator(sessionId?: string) {
  let emitted = false;
  return {
    next: async () => {
      if (emitted) {
        return { done: true, value: undefined };
      }
      emitted = true;
      return { done: false, value: successfulResultMessage(sessionId) };
    },
  };
}

describe('ClaudeRuntimeService', () => {
  let service: ClaudeRuntimeService;
  let db: any;
  let interactionRows: Array<typeof schema.claudeToolInteractions.$inferSelect>;
  let sessionsService: {
    findOne: jest.Mock;
    updateStatus: jest.Mock;
    updateClaudeSessionId: jest.Mock;
    renameFromGeneratedTitle: jest.Mock;
  };
  let hooksService: EventEmitter & {
    updateStatus: jest.Mock;
    updateRuntimeActivity: jest.Mock;
    clearStatus: jest.Mock;
  };
  let terminalService: {
    startSession: jest.Mock;
  };
  let titleService: {
    generate: jest.Mock;
  };
  let loggerLogSpy: jest.SpyInstance;
  let loggerWarnSpy: jest.SpyInstance;
  let loggerDebugSpy: jest.SpyInstance;
  const originalClaudeBin = process.env.ELEVENEX_CLAUDE_BIN;

  beforeEach(async () => {
    jest.clearAllMocks();
    if (originalClaudeBin === undefined) {
      delete process.env.ELEVENEX_CLAUDE_BIN;
    } else {
      process.env.ELEVENEX_CLAUDE_BIN = originalClaudeBin;
    }
    loggerLogSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    loggerDebugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    interactionRows = [];
    db = {
      insert: jest.fn((table) => ({
        values: jest.fn((value) => ({
          onConflictDoUpdate: jest.fn(({ set }) => {
            const existingIndex = interactionRows.findIndex(
              (row) =>
                row.sessionId === value.sessionId &&
                row.toolUseId === value.toolUseId,
            );
            const nextRow = {
              id:
                existingIndex >= 0
                  ? interactionRows[existingIndex].id
                  : interactionRows.length + 1,
              ...value,
              ...set,
            };
            if (existingIndex >= 0) {
              interactionRows[existingIndex] = nextRow;
            } else {
              interactionRows.push(nextRow);
            }
            return Promise.resolve();
          }),
        })),
      })),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => Promise.resolve([...interactionRows])),
        })),
      })),
    };

    sessionsService = {
      findOne: jest.fn().mockResolvedValue({
        id: 7,
        worktreePath: '/tmp/project',
        claudeSessionId: 'claude-session-1',
      }),
      updateStatus: jest.fn(),
      updateClaudeSessionId: jest.fn(),
      renameFromGeneratedTitle: jest.fn(),
    };

    hooksService = Object.assign(new EventEmitter(), {
      updateStatus: jest.fn().mockResolvedValue(undefined),
      updateRuntimeActivity: jest.fn(),
      clearStatus: jest.fn(),
    });

    terminalService = {
      startSession: jest.fn(),
    };
    titleService = {
      generate: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaudeRuntimeService,
        { provide: DRIZZLE, useValue: db },
        { provide: SessionsService, useValue: sessionsService },
        { provide: ClaudeHooksService, useValue: hooksService },
        { provide: TerminalService, useValue: terminalService },
        { provide: SessionTitleService, useValue: titleService },
        {
          provide: SettingsService,
          useValue: {
            getAgentProviderDefaults: () => ({
              model: null,
              reasoningEffort: null,
            }),
          },
        },
      ],
    }).compile();

    service = module.get(ClaudeRuntimeService);
  });

  afterEach(() => {
    if (originalClaudeBin === undefined) {
      delete process.env.ELEVENEX_CLAUDE_BIN;
    } else {
      process.env.ELEVENEX_CLAUDE_BIN = originalClaudeBin;
    }
    loggerLogSpy.mockRestore();
    loggerWarnSpy.mockRestore();
    loggerDebugSpy.mockRestore();
  });

  it('falls back to unknown SDK metadata when package.json is unavailable', () => {
    expect(
      loadClaudeSdkPackageMetadata({
        runtimeRoot: '/tmp/elevenex-runtime',
        packageAnchors: [],
      }),
    ).toEqual({ version: 'unknown' });
  });

  it('returns a pending MCP URL elicitation for the requested server', () => {
    const state = (service as any).ensureRuntimeState(7);
    state.pendingUserInputRequest = {
      requestId: 'input-1',
      serverName: 'linear',
      message: 'Authenticate Linear',
      mode: 'url',
      url: 'https://auth.example.com/authorize?client_id=claude-code&state=pending',
      createdAt: new Date().toISOString(),
    };

    expect(service.getPendingMcpAuthUrl(7, 'linear')).toBe(
      'https://auth.example.com/authorize?client_id=claude-code&state=pending',
    );
    expect(service.getPendingMcpAuthUrl(7, 'other')).toBeNull();
  });

  it('uses effective Claude plan permission mode while preserving the base style', async () => {
    const options = await (service as any).buildQueryOptions(
      7,
      '/tmp/project',
      'claude-session-1',
      null,
      null,
      false,
      'acceptEdits',
      true,
      jest.fn(),
      jest.fn(),
    );
    const baseOptions = await (service as any).buildQueryOptions(
      7,
      '/tmp/project',
      'claude-session-1',
      null,
      null,
      false,
      'acceptEdits',
      false,
      jest.fn(),
      jest.fn(),
    );

    expect(options.permissionMode).toBe('plan');
    expect(baseOptions.permissionMode).toBe('acceptEdits');
  });

  it('runs review-autonomy agent sessions in auto mode but still asks for destructive elevenex tools', async () => {
    const options = await (service as any).buildQueryOptions(
      7,
      '/tmp/project',
      'claude-session-1',
      null,
      null,
      false,
      null,
      false,
      jest.fn(),
      jest.fn(),
      'agent',
      'review',
    );

    expect(options.permissionMode).toBe('auto');

    const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    expect(hook).toBeDefined();
    await expect(
      hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__elevenex__delete_worktree',
        tool_input: {},
        tool_use_id: 'tool-1',
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'ask' },
    });
    await expect(
      hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__elevenex__project_overview',
        tool_input: {},
        tool_use_id: 'tool-2',
      }),
    ).resolves.toEqual({});
  });

  it('leaves full-autonomy agent sessions on bypassPermissions with no destructive hook', async () => {
    const options = await (service as any).buildQueryOptions(
      7,
      '/tmp/project',
      'claude-session-1',
      null,
      null,
      false,
      null,
      false,
      jest.fn(),
      jest.fn(),
      'agent',
      'full',
    );

    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.hooks).toBeUndefined();
  });

  it('updates active Claude runtime when plan mode is toggled', async () => {
    const setPermissionMode = jest.fn().mockResolvedValue(undefined);
    const state = (service as any).ensureRuntimeState(7);
    state.selectedPermissionMode = 'acceptEdits';
    (service as any).sessionRuntimes.set(7, { setPermissionMode });

    const enabled = await service.setPlanMode(7, true);
    const disabled = await service.setPlanMode(7, false);

    expect(setPermissionMode).toHaveBeenNthCalledWith(1, 'plan');
    expect(setPermissionMode).toHaveBeenNthCalledWith(2, 'acceptEdits');
    expect(enabled).toMatchObject({
      permissionMode: 'acceptEdits',
      planMode: true,
    });
    expect(disabled).toMatchObject({
      permissionMode: 'acceptEdits',
      planMode: false,
    });
  });

  it('normalizes legacy Claude plan permission mode into separate plan mode', async () => {
    const state = (service as any).ensureRuntimeState(7);
    state.selectedPermissionMode = 'acceptEdits';

    const next = await service.setPermissionMode(7, 'plan');

    expect(next).toMatchObject({
      permissionMode: 'acceptEdits',
      planMode: true,
    });
  });

  it('publishes sidebar activity for running, action, resumed, and idle runtime states', () => {
    const state = (service as any).ensureRuntimeState(7);
    const emittedEvents: Array<{
      type: string;
      payload?: Record<string, unknown>;
    }> = [];
    service.on(
      'event',
      (event: { type: string; payload?: Record<string, unknown> }) =>
        emittedEvents.push(event),
    );

    state.runPhase = 'running';
    state.sessionState = 'running';
    (service as any).emitRunState(7);
    expect(hooksService.updateRuntimeActivity).toHaveBeenLastCalledWith(7, {
      activityStatus: 'running',
      actionKind: null,
      actionLabel: null,
    });

    state.pendingPermissionRequest = {
      requestId: 'perm-1',
      toolUseId: 'tool-1',
      toolName: 'Edit',
      input: {},
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    state.runPhase = 'waiting';
    state.sessionState = 'requires_action';
    (service as any).emitRunState(7);
    expect(hooksService.updateRuntimeActivity).toHaveBeenLastCalledWith(7, {
      activityStatus: 'waiting',
      actionKind: 'permission',
      actionLabel: 'Permission needed',
    });

    state.pendingPermissionRequest = null;
    state.pendingUserInputRequest = {
      requestId: 'input-1',
      serverName: 'linear',
      message: 'Authenticate Linear',
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    (service as any).emitRunState(7);
    expect(hooksService.updateRuntimeActivity).toHaveBeenLastCalledWith(7, {
      activityStatus: 'waiting',
      actionKind: 'user_input',
      actionLabel: 'Input needed',
    });

    state.pendingUserInputRequest = null;
    state.runPhase = 'running';
    state.sessionState = 'running';
    (service as any).emitRunState(7);
    expect(hooksService.updateRuntimeActivity).toHaveBeenLastCalledWith(7, {
      activityStatus: 'running',
      actionKind: null,
      actionLabel: null,
    });

    state.runPhase = 'idle';
    state.sessionState = 'idle';
    (service as any).emitRunState(7);
    expect(hooksService.updateRuntimeActivity).toHaveBeenLastCalledWith(7, {
      activityStatus: 'idle',
      actionKind: null,
      actionLabel: null,
    });

    const runStates = emittedEvents.filter(
      (event) => event.type === 'run_state',
    );
    expect(runStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            pendingPermissionRequest: expect.objectContaining({
              requestId: 'perm-1',
              toolUseId: 'tool-1',
            }),
            pendingUserInputRequest: null,
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            pendingPermissionRequest: null,
            pendingUserInputRequest: expect.objectContaining({
              requestId: 'input-1',
            }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            pendingPermissionRequest: null,
            pendingUserInputRequest: null,
          }),
        }),
      ]),
    );
  });

  it('starts MCP auth through the Claude Code SDK control channel', async () => {
    const close = jest.fn();
    const mcpAuthenticate = jest.fn().mockResolvedValue({
      authUrl:
        'https://auth.example.com/authorize?client_id=claude-code&redirect_uri=http%3A%2F%2Flocalhost%3A49152%2Fcallback&state=abc',
      requiresUserAction: true,
    });
    (query as jest.Mock).mockReturnValue({
      initializationResult: jest.fn().mockResolvedValue({}),
      mcpAuthenticate,
      close,
    });

    try {
      await expect(service.startMcpAuthFlow(7, 'linear')).resolves.toBe(
        'https://auth.example.com/authorize?client_id=claude-code&redirect_uri=http%3A%2F%2Flocalhost%3A49152%2Fcallback&state=abc',
      );

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            cwd: '/tmp/project',
            persistSession: false,
            settingSources: ['project', 'user', 'local'],
          }),
        }),
      );
      expect(mcpAuthenticate).toHaveBeenCalledWith('linear');
      // The loopback callback server (from the redirect_uri's localhost:49152)
      // must stay alive until the provider redirects back, so the subprocess
      // must NOT be torn down here. Tearing it down was the root cause of the
      // "MCP authentication callback unavailable" page.
      expect(close).not.toHaveBeenCalled();
    } finally {
      (query as jest.Mock).mockReset();
    }
  });

  it('keeps the auth subprocess alive briefly after the callback hits, then retires it', async () => {
    jest.useFakeTimers();
    const close = jest.fn();
    const mcpAuthenticate = jest.fn().mockResolvedValue({
      authUrl:
        'https://auth.example.com/authorize?client_id=claude-code&redirect_uri=http%3A%2F%2F127.0.0.1%3A3118%2Fcallback&state=abc',
      requiresUserAction: true,
    });
    (query as jest.Mock).mockReturnValue({
      initializationResult: jest.fn().mockResolvedValue({}),
      mcpAuthenticate,
      close,
    });

    try {
      await service.startMcpAuthFlow(7, 'datadog');

      // Callback arrives: the port is taken from the redirect_uri (3118), so
      // the proxy's notification matches the parked flow.
      service.notifyMcpAuthCallback(3118);

      // The subprocess is still alive while the CLI finishes the token
      // exchange...
      expect(close).not.toHaveBeenCalled();

      // ...then retired once the grace period elapses.
      jest.advanceTimersByTime(8 * 1000);
      expect(close).toHaveBeenCalled();
    } finally {
      (query as jest.Mock).mockReset();
      jest.useRealTimers();
    }
  });

  it('hydrates richer SDK runtime state and emits normalized events', async () => {
    const emittedTypes: string[] = [];
    service.on('event', (event: { type: string }) =>
      emittedTypes.push(event.type),
    );

    await (service as any).handleSdkMessage(7, {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'oauth',
      claude_code_version: '1.2.3',
      cwd: '/tmp/project',
      tools: ['Read', 'Edit'],
      mcp_servers: [{ name: 'docs', status: 'connected' }],
      model: 'sonnet',
      permissionMode: 'default',
      slash_commands: ['/help'],
      output_style: 'default',
      skills: ['$checks'],
      plugins: [{ name: 'market', path: '/plugins/market' }],
      agents: ['code-reviewer'],
      fast_mode_state: 'cooldown',
      uuid: 'init-1',
      session_id: 'claude-session-1',
    });

    await (service as any).handleSdkMessage(7, {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      permissionMode: 'auto',
      compact_result: 'success',
      uuid: 'status-1',
      session_id: 'claude-session-1',
    });

    await (service as any).handleSdkMessage(7, {
      type: 'auth_status',
      isAuthenticating: true,
      output: ['Opening browser'],
      uuid: 'auth-1',
      session_id: 'claude-session-1',
    });

    await (service as any).handleSdkMessage(7, {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        utilization: 0.92,
        rateLimitType: 'five_hour',
      },
      uuid: 'rate-1',
      session_id: 'claude-session-1',
    });

    await (service as any).handleSdkMessage(7, {
      type: 'prompt_suggestion',
      suggestion: 'Run the backend tests next.',
      uuid: 'prompt-1',
      session_id: 'claude-session-1',
    });

    const state = await service.getRuntimeState(7);

    expect(state.sessionMetadata).toEqual(
      expect.objectContaining({
        cwd: '/tmp/project',
        model: 'sonnet',
        claudeCodeVersion: '1.2.3',
        permissionMode: 'auto',
        fastModeState: 'cooldown',
      }),
    );
    expect(state.runtimeStatus).toEqual(
      expect.objectContaining({
        status: 'compacting',
        permissionMode: 'auto',
        compactResult: 'success',
      }),
    );
    expect(state.authStatus).toEqual({
      isAuthenticating: true,
      output: ['Opening browser'],
      error: undefined,
    });
    expect(state.rateLimit).toEqual(
      expect.objectContaining({
        status: 'allowed_warning',
        utilization: 0.92,
        rateLimitType: 'five_hour',
      }),
    );
    expect(state.latestPromptSuggestion).toEqual(
      expect.objectContaining({
        suggestion: 'Run the backend tests next.',
      }),
    );
    expect(emittedTypes).toEqual(
      expect.arrayContaining([
        'session_metadata',
        'runtime_status',
        'auth_status',
        'rate_limit',
        'prompt_suggestion',
      ]),
    );
  });

  it('builds autocomplete from Claude runtime metadata, ~/claude skills, and legacy command skills', async () => {
    const userClaudeRoot = join(homedir(), 'claude');
    const userSkillsDir = join(userClaudeRoot, 'skills');
    const userCommandsDir = join(userClaudeRoot, 'commands');

    jest
      .spyOn(service as never, 'collectClaudeProjectDirectories' as never)
      .mockResolvedValue([]);
    jest
      .spyOn(service as never, 'collectClaudeConfigDirectories' as never)
      .mockImplementation(async (subdir: 'commands' | 'skills') =>
        subdir === 'skills' ? [userSkillsDir] : [userCommandsDir],
      );
    jest
      .spyOn(service as never, 'pathExists' as never)
      .mockImplementation(
        async (targetPath: string) =>
          targetPath === userSkillsDir || targetPath === userCommandsDir,
      );
    jest
      .spyOn(service as never, 'walkDirectory' as never)
      .mockImplementation(async (baseDir: string) => {
        if (baseDir === userSkillsDir) {
          return [join(userSkillsDir, 'myskill', 'SKILL.md')];
        }
        if (baseDir === userCommandsDir) {
          return [
            join(userCommandsDir, 'legacy-skill', 'SKILL.md'),
            join(userCommandsDir, 'group', 'custom.md'),
          ];
        }
        return [];
      });
    const readAutocompleteMetadata = jest
      .spyOn(service as never, 'readAutocompleteMetadata' as never)
      .mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('myskill/SKILL.md')) {
          return { description: 'My Claude skill', userInvocable: true };
        }
        if (filePath.endsWith('legacy-skill/SKILL.md')) {
          return { description: 'Legacy command skill', userInvocable: true };
        }
        if (filePath.endsWith('group/custom.md')) {
          return { description: 'Grouped custom command', userInvocable: true };
        }
        return { description: 'Unknown', userInvocable: true };
      });

    const state = (service as any).ensureRuntimeState(7, 'claude-session-1');
    state.sessionMetadata = {
      cwd: '/tmp/project',
      model: 'sonnet',
      permissionMode: 'default',
      claudeCodeVersion: '1.2.3',
      outputStyle: 'default',
      apiKeySource: 'oauth',
      tools: [],
      slashCommands: ['/help', '/runtime-only'],
      skills: ['$runtime-skill'],
      agents: [],
      fastModeState: null,
      mcpServers: [],
      plugins: [],
    };

    const items = await service.getAutocompleteItems(7);
    const labels = items.map(
      (item) => `${item.trigger}:${item.label}:${item.detail ?? ''}`,
    );

    expect(labels).toContain('/:/runtime-only:Runtime command');
    expect(labels).toContain('/:/runtime-skill:Runtime skill');
    expect(labels).toContain('$:$runtime-skill:Runtime skill');
    expect(labels).toContain('/:/myskill:~/claude/skills');
    expect(labels).toContain('$:$myskill:~/claude/skills');
    expect(labels).toContain('/:/legacy-skill:~/claude/commands');
    expect(labels).toContain('/:/group/custom:~/claude/commands');

    expect(readAutocompleteMetadata).toHaveBeenCalledTimes(3);
  });

  it('tracks task, tool, file, memory, compact, mirror, and hook lifecycle state', async () => {
    const emittedTypes: string[] = [];
    service.on('event', (event: { type: string }) =>
      emittedTypes.push(event.type),
    );

    await (service as any).handleSdkMessage(7, {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      description: 'Investigate failing test',
      task_type: 'local_workflow',
      workflow_name: 'spec',
      tool_use_id: 'tool-1',
      uuid: 'task-start-1',
      session_id: 'claude-session-1',
    });

    await (service as any).handleSdkMessage(7, {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'task-1',
      description: 'Running targeted suite',
      tool_use_id: 'tool-1',
      usage: {
        total_tokens: 123,
        tool_uses: 2,
        duration_ms: 4500,
      },
      last_tool_name: 'Bash',
      summary: 'Running tests',
      uuid: 'task-progress-1',
      session_id: 'claude-session-1',
    });

    await (service as any).handleSdkMessage(7, {
      type: 'tool_progress',
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
      parent_tool_use_id: null,
      elapsed_time_seconds: 12,
      task_id: 'task-1',
      uuid: 'tool-progress-1',
      session_id: 'claude-session-1',
    });

    await (service as any).handleSdkMessage(7, {
      type: 'tool_use_summary',
      summary: 'Bash gathered failing assertions.',
      preceding_tool_use_ids: ['tool-1'],
      uuid: 'tool-summary-1',
      session_id: 'claude-session-1',
    });

    await (service as any).handleSdkMessage(7, {
      type: 'system',
      subtype: 'files_persisted',
      files: [{ filename: 'report.md', file_id: 'file-1' }],
      failed: [],
      processed_at: '2026-04-23T10:00:00.000Z',
      uuid: 'files-1',
      session_id: 'claude-session-1',
    });

    await (service as any).handleSdkMessage(7, {
      type: 'system',
      subtype: 'memory_recall',
      mode: 'select',
      memories: [{ path: '/memory/CLAUDE.md', scope: 'team' }],
      uuid: 'memory-1',
      session_id: 'claude-session-1',
    });

    await (service as any).handleSdkMessage(7, {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 90000,
        post_tokens: 30000,
        duration_ms: 2500,
      },
      uuid: 'compact-1',
      session_id: 'claude-session-1',
    });

    await (service as any).handleSdkMessage(7, {
      type: 'system',
      subtype: 'mirror_error',
      error: 'append failed',
      key: {
        projectKey: 'project',
        sessionId: 'claude-session-1',
        subpath: 'subagent.jsonl',
      },
      uuid: 'mirror-1',
      session_id: 'claude-session-1',
    });

    hooksService.emit('hook-event', {
      sessionId: 7,
      timestamp: '2026-04-23T10:05:00.000Z',
      payload: {
        hook_event_name: 'SubagentStart',
        session_id: 'claude-session-1',
        agent_id: 'agent-1',
        agent_type: 'code-reviewer',
      },
    });

    hooksService.emit('hook-event', {
      sessionId: 7,
      timestamp: '2026-04-23T10:06:00.000Z',
      payload: {
        hook_event_name: 'TaskCreated',
        session_id: 'claude-session-1',
        task_id: 'task-2',
        task_subject: 'Review changed files',
        task_description: 'Inspect backend-only delta',
        teammate_name: 'teammate-a',
        team_name: 'reviewers',
      },
    });

    const state = await service.getRuntimeState(7);

    expect(state.tasks[0]).toEqual(
      expect.objectContaining({
        taskId: 'task-2',
        status: 'pending',
        subject: 'Review changed files',
      }),
    );
    expect(state.tasks[1]).toEqual(
      expect.objectContaining({
        taskId: 'task-1',
        status: 'running',
        summary: 'Running tests',
      }),
    );
    expect(state.latestToolProgress).toEqual(
      expect.objectContaining({
        toolUseId: 'tool-1',
        taskId: 'task-1',
      }),
    );
    expect(state.latestToolSummary).toEqual(
      expect.objectContaining({
        summary: 'Bash gathered failing assertions.',
      }),
    );
    expect(state.latestFilesPersisted).toEqual(
      expect.objectContaining({
        files: [{ filename: 'report.md', fileId: 'file-1' }],
      }),
    );
    expect(state.latestMemoryRecall).toEqual(
      expect.objectContaining({
        mode: 'select',
      }),
    );
    expect(state.latestCompactBoundary).toEqual(
      expect.objectContaining({
        trigger: 'auto',
        preTokens: 90000,
      }),
    );
    expect(state.latestMirrorError).toEqual(
      expect.objectContaining({
        error: 'append failed',
      }),
    );
    expect(state.subagents).toEqual([
      expect.objectContaining({
        agentId: 'agent-1',
        agentType: 'code-reviewer',
        status: 'started',
      }),
    ]);
    expect(state.taskLifecycle).toEqual([
      expect.objectContaining({
        taskId: 'task-2',
        event: 'created',
      }),
    ]);
    expect(emittedTypes).toEqual(
      expect.arrayContaining([
        'task_started',
        'task_progress',
        'tool_progress',
        'tool_summary',
        'files_persisted',
        'memory_recall',
        'compact_boundary',
        'mirror_error',
        'hook_event',
        'subagent_lifecycle',
        'task_lifecycle',
      ]),
    );
  });

  it('emits partial assistant deltas into live runtime state before completion', async () => {
    const emittedEvents: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    service.on(
      'event',
      (event: { type: string; payload: Record<string, unknown> }) =>
        emittedEvents.push(event),
    );

    (service as any).activeRuns.set(7, {
      query: { close: jest.fn() },
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map(),
      permissionRequestOrder: [],
      userInputRequests: new Map(),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise: Promise.resolve(),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      runId: 'run-1',
      queryCreatedAtMs: Date.now(),
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: false,
      sawFirstVisibleItem: false,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrapper-1',
      session_id: 'claude-session-1',
      event: {
        type: 'message_start',
        message: {
          id: 'msg-1',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrapper-2',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: '',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrapper-3',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'Hello ',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrapper-4',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'world',
        },
      },
    });

    const state = await service.getRuntimeState(7);

    expect(state.liveItems).toEqual([
      expect.objectContaining({
        id: 'msg-1:0',
        kind: 'assistant',
        content: 'Hello world',
      }),
    ]);
    expect(emittedEvents.map((event) => event.type)).toEqual([
      'session_created',
      'message_start',
      'message_delta',
      'message_delta',
    ]);
    expect(emittedEvents[2]?.payload).toEqual(
      expect.objectContaining({
        sessionId: 7,
        itemId: 'msg-1:0',
        delta: 'Hello ',
      }),
    );
    expect(
      loggerDebugSpy.mock.calls.some(([message]) =>
        String(message).startsWith('Claude stream event '),
      ),
    ).toBe(false);
  });

  it('correlates stream deltas using message_start.message.id instead of wrapper event uuid', async () => {
    const emittedEvents: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    service.on(
      'event',
      (event: { type: string; payload: Record<string, unknown> }) =>
        emittedEvents.push(event),
    );

    (service as any).activeRuns.set(7, {
      query: { close: jest.fn() },
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map(),
      permissionRequestOrder: [],
      userInputRequests: new Map(),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise: Promise.resolve(),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      runId: 'run-1',
      queryCreatedAtMs: Date.now(),
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: false,
      sawFirstVisibleItem: false,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'event-a',
      session_id: 'claude-session-1',
      event: {
        type: 'message_start',
        message: {
          id: 'assistant-msg-42',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'event-b',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: '',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'event-c',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'Hello ',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'event-d',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'world',
        },
      },
    });

    expect(emittedEvents.map((event) => event.type)).toEqual([
      'session_created',
      'message_start',
      'message_delta',
      'message_delta',
    ]);
    expect(emittedEvents[1]?.payload).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'assistant-msg-42:0',
        }),
      }),
    );
    expect(emittedEvents[2]?.payload).toEqual(
      expect.objectContaining({
        itemId: 'assistant-msg-42:0',
        delta: 'Hello ',
      }),
    );
  });

  it('reuses the streamed assistant item when the final assistant message arrives', async () => {
    const emittedEvents: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    service.on(
      'event',
      (event: { type: string; payload: Record<string, unknown> }) =>
        emittedEvents.push(event),
    );

    (service as any).activeRuns.set(7, {
      query: { close: jest.fn() },
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map(),
      permissionRequestOrder: [],
      userInputRequests: new Map(),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise: Promise.resolve(),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      runId: 'run-1',
      queryCreatedAtMs: Date.now(),
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: false,
      sawFirstVisibleItem: false,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrap-1',
      session_id: 'claude-session-1',
      event: {
        type: 'message_start',
        message: {
          id: 'assistant-msg-99',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrap-2',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: '',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrap-3',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'Hello world',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrap-4',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_stop',
        index: 0,
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'assistant',
      uuid: 'final-wrapper',
      session_id: 'claude-session-1',
      message: {
        id: 'assistant-msg-99',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    });

    const state = await service.getRuntimeState(7);
    const assistantItems = state.liveItems.filter(
      (item) => item.kind === 'assistant',
    );

    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0]).toEqual(
      expect.objectContaining({
        id: 'assistant-msg-99:0',
        content: 'Hello world',
      }),
    );
    expect((service as any).activeRuns.get(7).partialAssistantItems.size).toBe(
      0,
    );
    expect(emittedEvents.map((event) => event.type)).toEqual([
      'session_created',
      'message_start',
      'message_delta',
      'message_complete',
      'message_complete',
    ]);
  });

  it('reuses the streamed text item when finalized assistant content omits a prior thinking block', async () => {
    (service as any).activeRuns.set(7, {
      query: { close: jest.fn() },
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map(),
      permissionRequestOrder: [],
      userInputRequests: new Map(),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise: Promise.resolve(),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      runId: 'run-1',
      queryCreatedAtMs: Date.now(),
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: false,
      sawFirstVisibleItem: false,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrap-think-1',
      session_id: 'claude-session-1',
      event: {
        type: 'message_start',
        message: {
          id: 'assistant-msg-think-first',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrap-think-2',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'thinking',
          thinking: '',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrap-think-3',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_delta',
          thinking: 'Reasoning...',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrap-think-4',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'text',
          text: '',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'stream_event',
      uuid: 'wrap-think-5',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'text_delta',
          text: 'Final answer',
        },
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'assistant',
      uuid: 'final-think-wrapper',
      session_id: 'claude-session-1',
      message: {
        id: 'assistant-msg-think-first',
        content: [{ type: 'text', text: 'Final answer' }],
      },
    });

    const state = await service.getRuntimeState(7);
    const assistantItems = state.liveItems.filter(
      (item) => item.kind === 'assistant',
    );
    const thinkingItems = state.liveItems.filter(
      (item) => item.kind === 'thinking',
    );

    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0]).toEqual(
      expect.objectContaining({
        id: 'assistant-msg-think-first:1',
        content: 'Final answer',
        sourceMessageId: 'assistant-msg-think-first',
      }),
    );
    expect(thinkingItems).toHaveLength(1);
    expect(thinkingItems[0]).toEqual(
      expect.objectContaining({
        id: 'assistant-msg-think-first:0',
        content: 'Reasoning...',
        sourceMessageId: 'assistant-msg-think-first',
      }),
    );
    expect((service as any).activeRuns.get(7).partialAssistantItems.size).toBe(
      0,
    );
  });

  it('uses the independently installed Claude CLI when submitting prompts', async () => {
    (query as jest.Mock).mockReturnValue({
      supportedModels: jest.fn().mockResolvedValue([]),
      getContextUsage: jest.fn().mockResolvedValue({
        model: 'sonnet',
        totalTokens: 0,
        maxTokens: 0,
        percentage: 0,
        apiUsage: undefined,
        autoCompactThreshold: 0,
        isAutoCompactEnabled: false,
        memoryFiles: [],
        mcpTools: [],
      }),
      close: jest.fn(),
      [Symbol.asyncIterator]: () => successfulResultIterator(),
    });

    await service.submitPrompt(7, 'Stream this');

    expect(query).toHaveBeenCalledTimes(1);
    expect((query as jest.Mock).mock.calls[0][0].options).toHaveProperty(
      'pathToClaudeCodeExecutable',
    );
  });

  it('queues prompts submitted while a run is still initializing', async () => {
    (service as any).initializingRuns.set(7, 'run-1');

    await service.submitPrompt(7, 'Queue this while startup awaits');

    expect(query).not.toHaveBeenCalled();
    expect((service as any).ensureRuntimeState(7).pendingPrompts).toEqual([
      expect.objectContaining({
        prompt: 'Queue this while startup awaits',
      }),
    ]);
  });

  it('clears the initializing guard if async runtime setup fails before the run is active', async () => {
    (service as any).buildQueryOptions = jest
      .fn()
      .mockRejectedValue(new Error('runtime setup failed'));

    await expect(service.submitPrompt(7, 'Start this')).rejects.toThrow(
      'runtime setup failed',
    );

    expect((service as any).initializingRuns.has(7)).toBe(false);
    expect((service as any).activeRuns.has(7)).toBe(false);
    expect((service as any).ensureRuntimeState(7)).toEqual(
      expect.objectContaining({
        lastError: 'runtime setup failed',
        runPhase: 'error',
        sessionState: 'idle',
        canInterrupt: false,
      }),
    );
  });

  it('generates and saves a text-only Haiku session title', async () => {
    titleService.generate.mockResolvedValue('Implement Auto Names');

    await (service as any).generateAndSaveSessionTitle(
      7,
      '/tmp/project',
      'Please implement auto names',
    );

    expect(titleService.generate).toHaveBeenCalledWith(
      '/tmp/project',
      'Please implement auto names',
    );
    expect(sessionsService.renameFromGeneratedTitle).toHaveBeenCalledWith(
      7,
      'Implement Auto Names',
    );
  });

  it('starts first-prompt title generation before the Claude turn completes', async () => {
    sessionsService.findOne.mockResolvedValue({
      id: 7,
      name: 'Session 7',
      worktreePath: '/tmp/project',
      claudeSessionId: '-1',
    });
    titleService.generate.mockResolvedValue('Implement Auto Names');
    sessionsService.renameFromGeneratedTitle.mockResolvedValue({
      name: 'Implement Auto Names',
    });

    let resolveTurn!: () => void;
    const submitTurn = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTurn = resolve;
        }),
    );
    jest.spyOn(service as any, 'ensureSessionRuntime').mockResolvedValue({
      startedAtMs: null,
      warmState: 'cold',
      submitTurn,
    });

    const submitPromise = service.submitPrompt(7, 'Please implement auto names');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(submitTurn).toHaveBeenCalled();
    expect(titleService.generate).toHaveBeenCalledWith(
      '/tmp/project',
      'Please implement auto names',
    );
    expect(sessionsService.renameFromGeneratedTitle).toHaveBeenCalledWith(
      7,
      'Implement Auto Names',
    );

    resolveTurn();
    await submitPromise;
  });

  it('does not generate a title for resumed sessions', async () => {
    (query as jest.Mock).mockReturnValue({
      supportedModels: jest.fn().mockResolvedValue([]),
      getContextUsage: jest.fn().mockResolvedValue({
        model: 'sonnet',
        totalTokens: 0,
        maxTokens: 0,
        percentage: 0,
        apiUsage: undefined,
        autoCompactThreshold: 0,
        isAutoCompactEnabled: false,
        memoryFiles: [],
        mcpTools: [],
      }),
      close: jest.fn(),
      [Symbol.asyncIterator]: () => successfulResultIterator(),
    });

    await service.submitPrompt(7, 'Continue this');
    await new Promise((resolve) => setImmediate(resolve));

    expect(query).toHaveBeenCalledTimes(1);
    expect(sessionsService.renameFromGeneratedTitle).not.toHaveBeenCalled();
  });

  it('does not generate a title for manually named first-message sessions', async () => {
    sessionsService.findOne.mockResolvedValue({
      id: 7,
      name: 'Manual Session Name',
      worktreePath: '/tmp/project',
      claudeSessionId: '-1',
    });
    (query as jest.Mock).mockReturnValue({
      supportedModels: jest.fn().mockResolvedValue([]),
      getContextUsage: jest.fn().mockResolvedValue({
        model: 'sonnet',
        totalTokens: 0,
        maxTokens: 0,
        percentage: 0,
        apiUsage: undefined,
        autoCompactThreshold: 0,
        isAutoCompactEnabled: false,
        memoryFiles: [],
        mcpTools: [],
      }),
      close: jest.fn(),
      [Symbol.asyncIterator]: () => successfulResultIterator(),
    });

    await service.submitPrompt(7, 'Start this');
    await new Promise((resolve) => setImmediate(resolve));

    expect(query).toHaveBeenCalledTimes(1);
    expect(sessionsService.renameFromGeneratedTitle).not.toHaveBeenCalled();
  });

  it('leaves the session name unchanged when Haiku title generation fails', async () => {
    sessionsService.findOne.mockResolvedValue({
      id: 7,
      name: 'Session 7',
      worktreePath: '/tmp/project',
      claudeSessionId: '-1',
    });
    titleService.generate.mockRejectedValue(new Error('title failed'));
    (query as jest.Mock).mockReturnValue({
      supportedModels: jest.fn().mockResolvedValue([]),
      getContextUsage: jest.fn().mockResolvedValue({
        model: 'sonnet',
        totalTokens: 0,
        maxTokens: 0,
        percentage: 0,
        apiUsage: undefined,
        autoCompactThreshold: 0,
        isAutoCompactEnabled: false,
        memoryFiles: [],
        mcpTools: [],
      }),
      close: jest.fn(),
      [Symbol.asyncIterator]: () => successfulResultIterator(),
    });

    await service.submitPrompt(7, 'Start this');
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(sessionsService.renameFromGeneratedTitle).not.toHaveBeenCalled();
  });

  it('does not block the first Claude stream event on initial metadata refresh', async () => {
    sessionsService.findOne.mockResolvedValue({
      id: 7,
      name: 'Manual Session Name',
      worktreePath: '/tmp/project',
      claudeSessionId: '-1',
    });
    let resolveModels: ((value: unknown[]) => void) | null = null;
    let resolveUsage:
      | ((value: {
          model: string;
          totalTokens: number;
          maxTokens: number;
          percentage: number;
          apiUsage: undefined;
          autoCompactThreshold: number;
          isAutoCompactEnabled: boolean;
          memoryFiles: never[];
          mcpTools: never[];
        }) => void)
      | null = null;
    let emitted = false;
    let emittedResult = false;
    let releaseIterator: (() => void) | null = null;

    const emittedEvents: string[] = [];
    service.on('event', (event: { type: string }) =>
      emittedEvents.push(event.type),
    );

    (query as jest.Mock).mockReturnValue({
      supportedModels: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveModels = resolve;
          }),
      ),
      getContextUsage: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveUsage = resolve;
          }),
      ),
      close: jest.fn(),
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (!emitted) {
            emitted = true;
            return {
              done: false,
              value: {
                type: 'stream_event',
                uuid: 'stream-1',
                session_id: 'claude-session-1',
                event: {
                  type: 'message_start',
                  message: { id: 'msg-1' },
                },
              },
            };
          }

          await new Promise<void>((resolve) => {
            releaseIterator = resolve;
          });
          if (!emittedResult) {
            emittedResult = true;
            return { done: false, value: successfulResultMessage() };
          }
          return { done: true, value: undefined };
        },
      }),
    });

    const submitPromise = service.submitPrompt(7, 'Start streaming');
    while (!releaseIterator) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(emittedEvents).toContain('session_created');

    resolveModels?.([]);
    resolveUsage?.({
      model: 'sonnet',
      totalTokens: 0,
      maxTokens: 0,
      percentage: 0,
      apiUsage: undefined,
      autoCompactThreshold: 0,
      isAutoCompactEnabled: false,
      memoryFiles: [],
      mcpTools: [],
    });

    releaseIterator?.();
    await submitPromise;
  });

  it('coalesces repeated metadata refreshes for the same active run', async () => {
    let resolveModels: ((value: unknown[]) => void) | null = null;
    let resolveUsage:
      | ((value: {
          model: string;
          totalTokens: number;
          maxTokens: number;
          percentage: number;
          apiUsage: undefined;
          autoCompactThreshold: number;
          isAutoCompactEnabled: boolean;
          memoryFiles: never[];
          mcpTools: never[];
        }) => void)
      | null = null;

    const supportedModels = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveModels = resolve;
        }),
    );
    const getContextUsage = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUsage = resolve;
        }),
    );

    (service as any).activeRuns.set(7, {
      query: { supportedModels, getContextUsage, close: jest.fn() },
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map(),
      permissionRequestOrder: [],
      userInputRequests: new Map(),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise: Promise.resolve(),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      runId: 'run-refresh',
      queryCreatedAtMs: Date.now(),
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: false,
      sawFirstVisibleItem: false,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    });

    const first = (service as any).refreshRuntimeMetadata(7, {
      reason: 'test',
    });
    const second = (service as any).refreshRuntimeMetadata(7, {
      reason: 'test',
    });

    expect(supportedModels).toHaveBeenCalledTimes(1);
    expect(getContextUsage).toHaveBeenCalledTimes(1);

    resolveModels?.([]);
    resolveUsage?.({
      model: 'sonnet',
      totalTokens: 0,
      maxTokens: 0,
      percentage: 0,
      apiUsage: undefined,
      autoCompactThreshold: 0,
      isAutoCompactEnabled: false,
      memoryFiles: [],
      mcpTools: [],
    });

    await Promise.all([first, second]);
  });

  it('logs structured startup timing with resume diagnostics and first-visible buckets', async () => {
    sessionsService.findOne.mockResolvedValue({
      id: 7,
      worktreePath: '/tmp/project',
      claudeSessionId: 'claude-session-1',
    });

    const state = (service as any).ensureRuntimeState(7, 'claude-session-1');
    state.lastHistoryItemCount = 12;
    state.lastHistoryLoadedAtMs = Date.now() - 500;
    state.lastHistorySource = 'sdk';
    state.transcriptFallbackUsed = false;
    let step = 0;

    (query as jest.Mock).mockReturnValue({
      supportedModels: jest.fn().mockResolvedValue([]),
      getContextUsage: jest.fn().mockResolvedValue({
        model: 'sonnet',
        totalTokens: 0,
        maxTokens: 0,
        percentage: 0,
        apiUsage: undefined,
        autoCompactThreshold: 0,
        isAutoCompactEnabled: false,
        memoryFiles: [],
        mcpTools: [],
      }),
      close: jest.fn(),
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          step += 1;
          if (step === 1) {
            return {
              done: false,
              value: {
                type: 'system',
                subtype: 'init',
                apiKeySource: 'oauth',
                claude_code_version: '1.2.3',
                cwd: '/tmp/project',
                tools: [],
                mcp_servers: [],
                model: 'sonnet',
                permissionMode: 'default',
                slash_commands: [],
                output_style: 'default',
                skills: [],
                plugins: [],
                agents: [],
                fast_mode_state: null,
                uuid: 'init-1',
                session_id: 'claude-session-1',
              },
            };
          }

          if (step === 2) {
            return {
              done: false,
              value: {
                type: 'stream_event',
                uuid: 'stream-1',
                session_id: 'claude-session-1',
                event: {
                  type: 'message_start',
                  message: { id: 'msg-1' },
                },
              },
            };
          }

          if (step === 3) {
            return {
              done: false,
              value: {
                type: 'stream_event',
                uuid: 'stream-2',
                session_id: 'claude-session-1',
                event: {
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'text', text: '' },
                },
              },
            };
          }

          if (step === 4) {
            return {
              done: false,
              value: {
                type: 'result',
                subtype: 'success',
                duration_ms: 10,
                duration_api_ms: 10,
                is_error: false,
                num_turns: 1,
                session_id: 'claude-session-1',
                total_cost_usd: 0,
                usage: {
                  input_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  output_tokens: 0,
                  server_tool_use: {
                    web_search_requests: 0,
                  },
                },
                result: 'Done',
                stop_reason: 'end_turn',
              },
            };
          }

          return { done: true, value: undefined };
        },
      }),
    });

    await service.submitPrompt(7, 'Trace this');

    const debugMessages = loggerDebugSpy.mock.calls.map(([message]) =>
      String(message),
    );
    expect(
      debugMessages.some((message) => message.includes('stage=submit_start')),
    ).toBe(true);
    expect(
      debugMessages.some((message) =>
        message.includes('stage=runtime_query_created'),
      ),
    ).toBe(true);
    expect(
      debugMessages.some((message) =>
        message.includes('stage=resume_diagnostics'),
      ),
    ).toBe(true);
    expect(
      debugMessages.some((message) =>
        message.includes('stage=first_sdk_message:system'),
      ),
    ).toBe(true);
    expect(
      debugMessages.some((message) =>
        message.includes('stage=pre_visible_system:init'),
      ),
    ).toBe(true);
    expect(
      debugMessages.some((message) =>
        message.includes('stage=first_visible_message_start'),
      ),
    ).toBe(true);
    expect(
      debugMessages.some((message) => message.includes('preVisibleSummary')),
    ).toBe(true);
    expect(
      debugMessages.some((message) => message.includes('stage=run_complete')),
    ).toBe(true);
  });

  it('records history source and count for resumed-session diagnostics', async () => {
    (getSessionMessages as jest.Mock).mockResolvedValue([
      {
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-04-24T08:00:00.000Z',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
      },
    ]);

    const history = await service.getHistory(7);
    const state = (service as any).ensureRuntimeState(7, 'claude-session-1');

    expect(history).toHaveLength(1);
    expect(state.lastHistoryItemCount).toBe(1);
    expect(state.lastHistorySource).toBe('sdk');
    expect(state.transcriptFallbackUsed).toBe(false);
    expect(state.lastHistoryLoadedAtMs).toEqual(expect.any(Number));
  });

  it('reports a missing configured Claude CLI without falling back to the SDK executable', async () => {
    process.env.ELEVENEX_CLAUDE_BIN = '/definitely/missing/claude';

    await expect(service.getCliStatus()).resolves.toEqual(
      expect.objectContaining({
        installed: false,
        authenticated: false,
        installHint: expect.any(String),
      }),
    );
  });

  it('uses ELEVENEX_CLAUDE_BIN when configured', async () => {
    process.env.ELEVENEX_CLAUDE_BIN = '/custom/bin/claude';

    const overrideService = Object.assign(
      Object.create(Object.getPrototypeOf(service)),
      service,
      {
        claudeCliOverride: {
          path: '/custom/bin/claude',
          version: '2.1.118 (Claude Code)',
        },
      },
    ) as ClaudeRuntimeService;

    const options = await (overrideService as any).buildQueryOptions(
      7,
      '/tmp/project',
      'claude-session-1',
      null,
      null,
      false,
      null,
      jest.fn(),
      jest.fn(),
    );

    expect(options.pathToClaudeCodeExecutable).toBe('/custom/bin/claude');
  });

  it('warns when the installed Claude CLI version does not match SDK parity', () => {
    (service as any).claudeCliOverride = {
      path: '/custom/bin/claude',
      version: '2.1.81 (Claude Code)',
      configured: true,
    };

    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation();
    (service as any).logClaudeRuntimeConfiguration();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Claude CLI version mismatch: sdk expects 2.1.131, installed CLI reports 2.1.81 (Claude Code).',
      ),
    );
  });

  it('preserves authored and received timestamps when hydrating history', async () => {
    (getSessionMessages as jest.Mock).mockResolvedValue([
      {
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-04-24T08:00:00.000Z',
        message: {
          content: [{ type: 'text', text: 'Ship it' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-04-24T08:00:07.000Z',
        message: {
          content: [
            { type: 'thinking', thinking: 'Checking changes' },
            { type: 'text', text: 'Done.' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file: 'README.md' },
            },
          ],
        },
      },
    ]);

    const history = await service.getHistory(7);

    expect(history).toEqual([
      expect.objectContaining({
        id: 'user-1:user:0',
        kind: 'user',
        timestamp: '2026-04-24T08:00:00.000Z',
        authoredAt: '2026-04-24T08:00:00.000Z',
        sourceMessageId: 'user-1',
      }),
      expect.objectContaining({
        id: 'assistant-1:thinking:0',
        kind: 'thinking',
        timestamp: '2026-04-24T08:00:07.000Z',
        receivedAt: '2026-04-24T08:00:07.000Z',
        sourceMessageId: 'assistant-1',
      }),
      expect.objectContaining({
        id: 'assistant-1:assistant:1',
        kind: 'assistant',
        timestamp: '2026-04-24T08:00:07.000Z',
        receivedAt: '2026-04-24T08:00:07.000Z',
        sourceMessageId: 'assistant-1',
      }),
      expect.objectContaining({
        id: 'assistant-1:tool_use:tool-1',
        kind: 'tool_use',
        timestamp: '2026-04-24T08:00:07.000Z',
        receivedAt: '2026-04-24T08:00:07.000Z',
        sourceMessageId: 'assistant-1',
      }),
    ]);
  });

  it('falls back to transcript records when SDK history lookup returns empty', async () => {
    (getSessionMessages as jest.Mock).mockResolvedValue([]);
    jest
      .spyOn(service as never, 'findTranscriptPath' as never)
      .mockResolvedValue(
        '/tmp/.claude/projects/project/claude-session-1.jsonl',
      );
    jest
      .spyOn(service as never, 'loadTranscriptRecords' as never)
      .mockResolvedValue([
        {
          type: 'user',
          uuid: 'user-fallback-1',
          timestamp: '2026-04-24T09:00:00.000Z',
          message: {
            content: [{ type: 'text', text: 'Recovered from transcript' }],
          },
        },
      ]);

    const history = await service.getHistory(7);

    expect(history).toEqual([
      expect.objectContaining({
        id: 'user-fallback-1:user:0',
        kind: 'user',
        content: 'Recovered from transcript',
      }),
    ]);
  });

  it('normalizes transcript user messages whose content is a plain string', async () => {
    (getSessionMessages as jest.Mock).mockResolvedValue([]);
    jest
      .spyOn(service as never, 'findTranscriptPath' as never)
      .mockResolvedValue(
        '/tmp/.claude/projects/project/claude-session-1.jsonl',
      );
    jest
      .spyOn(service as never, 'loadTranscriptRecords' as never)
      .mockResolvedValue([
        {
          type: 'user',
          uuid: 'user-string-1',
          timestamp: '2026-04-24T09:00:00.000Z',
          message: {
            role: 'user',
            content: 'how r u ?',
          },
        },
        {
          type: 'user',
          uuid: 'user-string-2',
          timestamp: '2026-04-24T09:00:01.000Z',
          message: {
            role: 'user',
            content: 'yes',
          },
        },
      ]);

    const history = await service.getHistory(7);

    expect(history).toEqual([
      expect.objectContaining({
        id: 'user-string-1:user:0',
        kind: 'user',
        content: 'how r u ?',
      }),
      expect.objectContaining({
        id: 'user-string-2:user:0',
        kind: 'user',
        content: 'yes',
      }),
    ]);
  });

  it('normalizes transcript fallback history from the active parentUuid branch', async () => {
    (getSessionMessages as jest.Mock).mockResolvedValue([]);
    jest
      .spyOn(service as never, 'findTranscriptPath' as never)
      .mockResolvedValue(
        '/tmp/.claude/projects/project/claude-session-1.jsonl',
      );
    jest
      .spyOn(service as never, 'loadTranscriptRecords' as never)
      .mockResolvedValue([
        {
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          timestamp: '2026-04-24T09:00:00.000Z',
          message: { content: [{ type: 'text', text: 'First prompt' }] },
        },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          parentUuid: 'user-1',
          timestamp: '2026-04-24T09:00:01.000Z',
          message: { content: [{ type: 'text', text: 'First answer' }] },
        },
        {
          type: 'user',
          uuid: 'user-2',
          parentUuid: 'assistant-1',
          timestamp: '2026-04-24T09:00:02.000Z',
          message: { content: [{ type: 'text', text: 'Stale prompt' }] },
        },
        {
          type: 'assistant',
          uuid: 'assistant-2',
          parentUuid: 'user-2',
          timestamp: '2026-04-24T09:00:03.000Z',
          message: { content: [{ type: 'text', text: 'Stale answer' }] },
        },
        {
          type: 'user',
          uuid: 'user-3',
          parentUuid: 'assistant-1',
          timestamp: '2026-04-24T09:00:04.000Z',
          message: { content: [{ type: 'text', text: 'Restored prompt' }] },
        },
        {
          type: 'assistant',
          uuid: 'assistant-3',
          parentUuid: 'user-3',
          timestamp: '2026-04-24T09:00:05.000Z',
          message: { content: [{ type: 'text', text: 'Restored answer' }] },
        },
      ]);

    const history = await service.getHistory(7);

    expect(history.map((item) => item.content)).toEqual([
      'First prompt',
      'First answer',
      'Restored prompt',
      'Restored answer',
    ]);
  });

  it('falls back to transcript records when SDK history lookup throws', async () => {
    (getSessionMessages as jest.Mock).mockRejectedValue(
      new Error('lookup failed'),
    );
    jest
      .spyOn(service as never, 'findTranscriptPath' as never)
      .mockResolvedValue(
        '/tmp/.claude/projects/project/claude-session-1.jsonl',
      );
    jest
      .spyOn(service as never, 'loadTranscriptRecords' as never)
      .mockResolvedValue([
        {
          type: 'assistant',
          uuid: 'assistant-fallback-1',
          timestamp: '2026-04-24T09:00:02.000Z',
          message: {
            content: [{ type: 'text', text: 'Recovered assistant reply' }],
          },
        },
      ]);

    const history = await service.getHistory(7);

    expect(history).toEqual([
      expect.objectContaining({
        id: 'assistant-fallback-1:assistant:0',
        kind: 'assistant',
        content: 'Recovered assistant reply',
      }),
    ]);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load Claude history for session 7'),
    );
  });

  it('keeps nested subagent transcript items attached to their parent tool use', async () => {
    await (service as any).handleSdkMessage(7, {
      type: 'assistant',
      uuid: 'assistant-parented-1',
      session_id: 'claude-session-1',
      parent_tool_use_id: 'agent-tool-1',
      message: {
        content: [
          { type: 'text', text: 'Exploring the codebase' },
          {
            type: 'tool_use',
            id: 'child-tool-1',
            name: 'Read',
            input: { file_path: 'README.md' },
          },
        ],
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'user',
      uuid: 'user-parented-1',
      session_id: 'claude-session-1',
      parent_tool_use_id: 'agent-tool-1',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'child-tool-1',
            content: 'done',
            is_error: false,
          },
        ],
      },
    });

    const state = await service.getRuntimeState(7);

    expect(state.liveItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          parentToolUseId: 'agent-tool-1',
        }),
        expect.objectContaining({
          kind: 'tool_use',
          toolUseId: 'child-tool-1',
          parentToolUseId: 'agent-tool-1',
        }),
        expect.objectContaining({
          kind: 'tool_result',
          toolUseId: 'child-tool-1',
          parentToolUseId: 'agent-tool-1',
        }),
      ]),
    );
  });

  it('returns normalized subagent history for a tracked agent transcript', async () => {
    (service as any).ensureRuntimeState(7, 'claude-session-1').subagents = [
      {
        agentId: 'agent-1',
        agentType: 'code-reviewer',
        status: 'stopped',
        transcriptPath: '/tmp/agent-1.jsonl',
        lastAssistantMessage: 'Done.',
        timestamp: '2026-04-24T08:00:07.000Z',
      },
    ];

    (getSubagentMessages as jest.Mock).mockResolvedValue([
      {
        type: 'user',
        uuid: 'agent-user-1',
        timestamp: '2026-04-24T08:00:00.000Z',
        message: {
          content: [{ type: 'text', text: 'Inspect the failing tests' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'agent-assistant-1',
        timestamp: '2026-04-24T08:00:07.000Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file: 'README.md' },
            },
            { type: 'text', text: 'Done.' },
          ],
        },
      },
    ]);

    const result = await service.getSubagentHistory(7, 'agent-1');

    expect(result).toEqual({
      subagent: expect.objectContaining({
        agentId: 'agent-1',
        agentType: 'code-reviewer',
      }),
      transcriptAvailable: true,
      history: [
        expect.objectContaining({
          id: 'agent-user-1:user:0',
          kind: 'user',
          authoredAt: '2026-04-24T08:00:00.000Z',
        }),
        expect.objectContaining({
          id: 'agent-assistant-1:tool_use:tool-1',
          kind: 'tool_use',
          receivedAt: '2026-04-24T08:00:07.000Z',
        }),
        expect.objectContaining({
          id: 'agent-assistant-1:assistant:1',
          kind: 'assistant',
          receivedAt: '2026-04-24T08:00:07.000Z',
        }),
      ],
    });
  });

  it('suppresses known SDK stop errors after an interrupt request', async () => {
    let interrupted = false;
    let releaseIteration: (() => void) | null = null;
    let iterationStarted = false;

    (query as jest.Mock).mockReturnValue({
      supportedModels: jest.fn().mockResolvedValue([]),
      getContextUsage: jest.fn().mockResolvedValue({
        model: 'sonnet',
        totalTokens: 0,
        maxTokens: 0,
        percentage: 0,
        apiUsage: undefined,
        autoCompactThreshold: 0,
        isAutoCompactEnabled: false,
        memoryFiles: [],
        mcpTools: [],
      }),
      interrupt: jest.fn().mockImplementation(async () => {
        interrupted = true;
      }),
      close: jest.fn(),
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          iterationStarted = true;
          if (!interrupted) {
            await new Promise<void>((resolve) => {
              releaseIteration = resolve;
            });
          }

          throw new Error(
            '404 {"detail":"Unknown compliance rule for api: /v1/messages/count_tokens for provider: anthropic","status":404}',
          );
        },
      }),
    });

    const emittedEvents: string[] = [];
    service.on('event', (event: { type: string }) =>
      emittedEvents.push(event.type),
    );

    const submitPromise = service.submitPrompt(7, 'Stop now');
    while (!iterationStarted) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const interruptPromise = service.interrupt(7);
    await new Promise((resolve) => setImmediate(resolve));

    const midInterruptState = await service.getRuntimeState(7);
    expect(midInterruptState.runPhase).toBe('idle');
    expect(midInterruptState.canInterrupt).toBe(false);

    releaseIteration?.();
    await interruptPromise;

    await expect(submitPromise).resolves.toBeUndefined();

    const runtimeState = await service.getRuntimeState(7);
    expect(runtimeState.runPhase).toBe('idle');
    expect(runtimeState.lastError).toBeNull();
    expect(emittedEvents).not.toContain('error');
    expect(emittedEvents).toContain('complete');
  });

  it('interrupt clears a pending permission request immediately', async () => {
    const resolvePermission = jest.fn();
    const resolveQueuedPermission = jest.fn();
    const interrupt = jest.fn().mockResolvedValue(undefined);
    const close = jest.fn();
    const emittedEvents: string[] = [];
    service.on('event', (event: { type: string }) =>
      emittedEvents.push(event.type),
    );

    (service as any).activeRuns.set(7, {
      query: { interrupt, close },
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map([
        [
          'perm-1',
          {
            request: {
              requestId: 'perm-1',
              toolName: 'Edit',
              input: {},
              createdAt: 'now',
            },
            resolve: resolvePermission,
          },
        ],
        [
          'perm-2',
          {
            request: {
              requestId: 'perm-2',
              toolName: 'Bash',
              input: {},
              createdAt: 'later',
            },
            resolve: resolveQueuedPermission,
          },
        ],
      ]),
      permissionRequestOrder: ['perm-1', 'perm-2'],
      userInputRequests: new Map(),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise: Promise.resolve(),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      runId: 'run-1',
      queryCreatedAtMs: Date.now(),
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: false,
      sawFirstVisibleItem: false,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    });
    const state = (service as any).ensureRuntimeState(7, 'claude-session-1');
    state.runPhase = 'waiting';
    state.sessionState = 'requires_action';
    state.canInterrupt = true;
    state.pendingPermissionRequest = {
      requestId: 'perm-1',
      toolName: 'Edit',
      input: {},
      createdAt: 'now',
    };

    await service.interrupt(7);

    const runtimeState = await service.getRuntimeState(7);
    expect(resolvePermission).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'Run interrupted by user',
    });
    expect(resolveQueuedPermission).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'Run interrupted by user',
    });
    expect(interrupt).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(runtimeState.pendingPermissionRequest).toBeNull();
    expect(runtimeState.canInterrupt).toBe(false);
    expect(runtimeState.runPhase).toBe('idle');
    expect(emittedEvents).toContain('run_state');
  });

  it('promotes queued permission requests in order after the current one resolves', async () => {
    const emittedEvents: Array<{
      type: string;
      payload?: Record<string, unknown>;
    }> = [];
    service.on(
      'event',
      (event: { type: string; payload?: Record<string, unknown> }) =>
        emittedEvents.push(event),
    );

    const run = {
      query: { close: jest.fn() },
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map([
        [
          'perm-1',
          {
            request: {
              requestId: 'perm-1',
              toolName: 'Edit',
              input: {},
              createdAt: 'now',
            },
            resolve: jest.fn(),
          },
        ],
        [
          'perm-2',
          {
            request: {
              requestId: 'perm-2',
              toolName: 'Bash',
              input: { command: 'cat /tmp/file.txt' },
              createdAt: 'later',
            },
            resolve: jest.fn(),
          },
        ],
      ]),
      permissionRequestOrder: ['perm-2'],
      userInputRequests: new Map(),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise: Promise.resolve(),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      runId: 'run-1',
      queryCreatedAtMs: Date.now(),
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: false,
      sawFirstVisibleItem: false,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    };
    const state = (service as any).ensureRuntimeState(7, 'claude-session-1');
    state.pendingPermissionRequest = {
      requestId: 'perm-1',
      toolName: 'Edit',
      input: {},
      createdAt: 'now',
    };
    state.runPhase = 'waiting';
    state.sessionState = 'requires_action';

    (service as any).promoteNextPendingPermissionRequest(7, state, run);

    expect(state.pendingPermissionRequest).toEqual(
      expect.objectContaining({
        requestId: 'perm-2',
        toolName: 'Bash',
      }),
    );
    expect(state.runPhase).toBe('waiting');
    expect(state.sessionState).toBe('requires_action');
    expect(
      emittedEvents.some(
        (event) =>
          event.type === 'permission_request' &&
          event.payload?.['request'] &&
          (event.payload['request'] as { requestId?: string }).requestId ===
            'perm-2',
      ),
    ).toBe(true);
  });

  it('clears stale pending permission when a resolved tool result arrives', () => {
    const emittedEvents: Array<{
      type: string;
      payload?: Record<string, unknown>;
    }> = [];
    service.on(
      'event',
      (event: { type: string; payload?: Record<string, unknown> }) =>
        emittedEvents.push(event),
    );

    const permissionRequests = new Map([
      [
        'perm-1',
        {
          request: {
            requestId: 'perm-1',
            toolUseId: 'tool-1',
            toolName: 'ExitPlanMode',
            input: {},
            createdAt: 'now',
          },
          resolve: jest.fn(),
        },
      ],
    ]);
    (service as any).activeRuns.set(7, {
      query: { close: jest.fn() },
      interruptRequested: false,
      tornDown: false,
      permissionRequests,
      permissionRequestOrder: ['perm-1'],
      userInputRequests: new Map(),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise: Promise.resolve(),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      runId: 'run-1',
      queryCreatedAtMs: Date.now(),
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: true,
      sawFirstVisibleItem: true,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    });

    const state = (service as any).ensureRuntimeState(7, 'claude-session-1');
    state.pendingPermissionRequest = {
      requestId: 'perm-1',
      toolUseId: 'tool-1',
      toolName: 'ExitPlanMode',
      input: {},
      createdAt: 'now',
    };
    state.runPhase = 'waiting';
    state.sessionState = 'requires_action';

    (service as any).handleUserMessage(7, {
      type: 'user',
      uuid: 'user-1',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'accepted' },
        ],
      },
    });

    expect(state.pendingPermissionRequest).toEqual(
      expect.objectContaining({ requestId: 'perm-1' }),
    );

    permissionRequests.delete('perm-1');
    (service as any).handleUserMessage(7, {
      type: 'user',
      uuid: 'user-2',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'accepted' },
        ],
      },
    });

    expect(state.pendingPermissionRequest).toBeNull();
    expect(state.runPhase).toBe('running');
    expect(state.sessionState).toBe('running');
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        type: 'run_state',
        payload: expect.objectContaining({
          pendingPermissionRequest: null,
        }),
      }),
    );
  });

  it('interrupt cancels a pending user input request immediately', async () => {
    const resolveUserInput = jest.fn();
    const interrupt = jest.fn().mockResolvedValue(undefined);
    const close = jest.fn();

    (service as any).activeRuns.set(7, {
      query: { interrupt, close },
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map(),
      permissionRequestOrder: [],
      userInputRequests: new Map([
        [
          'input-1',
          {
            request: {
              requestId: 'input-1',
              message: 'Continue?',
              createdAt: 'now',
            },
            resolve: resolveUserInput,
          },
        ],
      ]),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise: Promise.resolve(),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      runId: 'run-1',
      queryCreatedAtMs: Date.now(),
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: false,
      sawFirstVisibleItem: false,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    });
    const state = (service as any).ensureRuntimeState(7, 'claude-session-1');
    state.runPhase = 'waiting';
    state.sessionState = 'requires_action';
    state.canInterrupt = true;
    state.pendingUserInputRequest = {
      requestId: 'input-1',
      message: 'Continue?',
      createdAt: 'now',
    } as any;

    await service.interrupt(7);

    const runtimeState = await service.getRuntimeState(7);
    expect(resolveUserInput).toHaveBeenCalledWith({ action: 'cancel' });
    expect(interrupt).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(runtimeState.pendingUserInputRequest).toBeNull();
    expect(runtimeState.canInterrupt).toBe(false);
    expect(runtimeState.runPhase).toBe('idle');
  });

  it('ignores late Claude session id updates after cleanup invalidates the session', async () => {
    const run = {
      query: {
        interrupt: jest.fn().mockResolvedValue(undefined),
        close: jest.fn(),
      },
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map(),
      permissionRequestOrder: [],
      userInputRequests: new Map(),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise: Promise.resolve(),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      runId: 'run-1',
      queryCreatedAtMs: Date.now(),
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: false,
      sawFirstVisibleItem: false,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    };
    (service as any).activeRuns.set(7, run);
    (service as any).ensureRuntimeState(7, 'claude-session-1');

    await service.cleanupSession(7);

    await (service as any).handleSdkMessage(7, {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'oauth',
      claude_code_version: '1.2.3',
      cwd: '/tmp/project',
      tools: [],
      mcp_servers: [],
      model: 'sonnet',
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      agents: [],
      fast_mode_state: null,
      uuid: 'late-init',
      session_id: 'claude-session-late',
    });

    expect(sessionsService.updateClaudeSessionId).not.toHaveBeenCalled();
    expect(hooksService.clearStatus).toHaveBeenCalledWith(7);
    expect((service as any).runtimeStates.has(7)).toBe(false);
  });

  it('returns a graceful empty subagent history when the transcript is unavailable', async () => {
    (service as any).ensureRuntimeState(7, 'claude-session-1').subagents = [
      {
        agentId: 'agent-1',
        agentType: 'code-reviewer',
        status: 'started',
        transcriptPath: null,
        timestamp: '2026-04-24T08:00:00.000Z',
      },
    ];

    const result = await service.getSubagentHistory(7, 'agent-1');

    expect(result).toEqual({
      subagent: expect.objectContaining({ agentId: 'agent-1' }),
      history: [],
      transcriptAvailable: false,
      transcriptError: 'Transcript unavailable for this agent.',
    });
  });

  it('rejects subagent history requests for unknown agents', async () => {
    await expect(
      service.getSubagentHistory(7, 'missing-agent'),
    ).rejects.toThrow('Subagent not found for this session.');
  });

  it('rewinds conversation history from a selected user message and resets live runtime state', async () => {
    (service as any).ensureRuntimeState(7, 'claude-session-1').liveItems = [
      {
        id: 'live-1',
        kind: 'assistant',
        content: 'Still streaming',
        timestamp: '2026-04-24T08:10:00.000Z',
      },
    ];
    (service as any).ensureRuntimeState(7).pendingPermissionRequest = {
      requestId: 'perm-1',
      toolUseId: 'tool-1',
      toolName: 'Edit',
      input: {},
      createdAt: '2026-04-24T08:10:01.000Z',
    };
    (service as any).ensureRuntimeState(7).runPhase = 'waiting';
    (service as any).ensureRuntimeState(7).sessionState = 'requires_action';

    jest
      .spyOn(service as any, 'findTranscriptPath')
      .mockResolvedValue('/tmp/claude-session-1.jsonl');
    jest.spyOn(service as any, 'loadTranscriptRecords').mockResolvedValue([
      { type: 'user', uuid: 'user-1' },
      { type: 'assistant', uuid: 'assistant-1' },
      { type: 'file-history-snapshot', messageId: 'user-2' },
      { type: 'user', uuid: 'user-2' },
      { type: 'assistant', uuid: 'assistant-2' },
      { type: 'last-prompt', lastPrompt: 'second prompt' },
    ]);
    const persistSpy = jest
      .spyOn(service as any, 'persistTranscriptRecords')
      .mockResolvedValue(undefined);
    (getSessionMessages as jest.Mock).mockResolvedValue([
      {
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-04-24T08:00:00.000Z',
        message: {
          content: [{ type: 'text', text: 'first prompt' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-04-24T08:00:01.000Z',
        message: {
          content: [{ type: 'text', text: 'first answer' }],
        },
      },
    ]);

    const history = await service.rewindConversation(7, 'user-2');

    expect(persistSpy).toHaveBeenCalledWith('/tmp/claude-session-1.jsonl', [
      { type: 'user', uuid: 'user-1' },
      { type: 'assistant', uuid: 'assistant-1' },
    ]);
    expect(history).toEqual([
      expect.objectContaining({
        content: 'first prompt',
        sourceMessageId: 'user-1',
      }),
      expect.objectContaining({
        content: 'first answer',
        sourceMessageId: 'assistant-1',
      }),
    ]);
    const runtimeState = await service.getRuntimeState(7);
    expect(runtimeState.liveItems).toEqual([]);
    expect(runtimeState.pendingPermissionRequest).toBeNull();
    expect(runtimeState.runPhase).toBe('idle');
    expect(runtimeState.sessionState).toBe('idle');
  });

  it('rejects rewind requests for non-user transcript entries', async () => {
    jest
      .spyOn(service as any, 'findTranscriptPath')
      .mockResolvedValue('/tmp/claude-session-1.jsonl');
    jest.spyOn(service as any, 'loadTranscriptRecords').mockResolvedValue([
      { type: 'user', uuid: 'user-1' },
      { type: 'assistant', uuid: 'assistant-1' },
    ]);

    await expect(service.rewindConversation(7, 'assistant-1')).rejects.toThrow(
      'Only user messages can be edited.',
    );
  });

  it('uses the Claude SDK fork API through the selected assistant message', async () => {
    jest
      .spyOn(service as any, 'findTranscriptPath')
      .mockResolvedValue('/tmp/claude-session-1.jsonl');
    jest.spyOn(service as any, 'loadTranscriptRecords').mockResolvedValue([
      { type: 'user', uuid: 'user-1', message: { content: 'first' } },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        message: { content: [{ type: 'text', text: 'answer' }] },
      },
      { type: 'user', uuid: 'user-2', message: { content: 'later' } },
    ]);
    (forkSession as jest.Mock).mockResolvedValue({ sessionId: 'forked-1' });

    const result = await service.forkConversation({
      parentSessionId: 7,
      childSessionId: 8,
      anchorMessageId: 'assistant-1',
      anchorMessageKind: 'assistant',
      childSessionName: 'Fork',
    });

    expect(forkSession).toHaveBeenCalledWith('claude-session-1', {
      dir: '/tmp/project',
      upToMessageId: 'assistant-1',
      title: 'Fork',
    });
    expect(result).toEqual({
      providerSessionId: 'forked-1',
      draft: null,
      anchorExcerpt: 'answer',
    });
  });

  it('forks Claude while waiting on the matching ExitPlanMode tool permission', async () => {
    jest
      .spyOn(service as any, 'findTranscriptPath')
      .mockResolvedValue('/tmp/claude-session-1.jsonl');
    jest.spyOn(service as any, 'loadTranscriptRecords').mockResolvedValue([
      { type: 'user', uuid: 'user-1', message: { content: 'make a plan' } },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          content: [
            { type: 'text', text: 'Here is the plan.' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'ExitPlanMode',
              input: { plan: '# Plan' },
            },
          ],
        },
      },
    ]);
    (forkSession as jest.Mock).mockResolvedValue({ sessionId: 'forked-plan' });

    (service as any).activeRuns.set(7, {
      query: { close: jest.fn() },
      worktreePath: '/tmp/project',
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map(),
      permissionRequestOrder: [],
      userInputRequests: new Map(),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise: Promise.resolve(),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      runId: 'run-1',
      queryCreatedAtMs: Date.now(),
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: true,
      sawFirstVisibleItem: true,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    });
    const state = (service as any).ensureRuntimeState(7, 'claude-session-1');
    state.pendingPermissionRequest = {
      requestId: 'perm-1',
      toolUseId: 'tool-1',
      toolName: 'ExitPlanMode',
      input: { plan: '# Plan' },
      createdAt: 'now',
    };
    state.runPhase = 'waiting';
    state.sessionState = 'requires_action';

    const result = await service.forkConversation({
      parentSessionId: 7,
      childSessionId: 8,
      anchorToolUseId: 'tool-1',
      activePermissionRequestId: 'perm-1',
      childSessionName: 'Plan Q&A',
    });

    expect(forkSession).toHaveBeenCalledWith('claude-session-1', {
      dir: '/tmp/project',
      upToMessageId: 'assistant-1',
      title: 'Plan Q&A',
    });
    expect(result).toEqual({
      providerSessionId: 'forked-plan',
      draft: null,
      anchorExcerpt: 'Here is the plan.',
    });
  });

  it('forks Claude before a selected user message and returns that text as a draft', async () => {
    jest
      .spyOn(service as any, 'findTranscriptPath')
      .mockResolvedValue('/tmp/claude-session-1.jsonl');
    jest.spyOn(service as any, 'loadTranscriptRecords').mockResolvedValue([
      { type: 'user', uuid: 'user-1', message: { content: 'first' } },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        message: { content: [{ type: 'text', text: 'answer' }] },
      },
      { type: 'user', uuid: 'user-2', message: { content: 'retry this' } },
    ]);
    (forkSession as jest.Mock).mockResolvedValue({ sessionId: 'forked-2' });

    const result = await service.forkConversation({
      parentSessionId: 7,
      childSessionId: 8,
      anchorMessageId: 'user-2',
      anchorMessageKind: 'user',
      childSessionName: 'Fork',
    });

    expect(forkSession).toHaveBeenCalledWith('claude-session-1', {
      dir: '/tmp/project',
      upToMessageId: 'assistant-1',
      title: 'Fork',
    });
    expect(result).toEqual({
      providerSessionId: 'forked-2',
      draft: 'retry this',
      anchorExcerpt: 'retry this',
    });
  });

  it('persists interaction summaries for approvals and updates the live tool card', async () => {
    (service as any).ensureRuntimeState(7, 'claude-session-1').liveItems = [
      {
        id: 'assistant-1:tool_use:tool-1',
        kind: 'tool_use',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
        timestamp: '2026-04-24T08:00:00.000Z',
      },
    ];

    const summary = await (service as any).recordInteractionSummary(
      7,
      {
        requestId: 'perm-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        input: { command: 'npm test' },
        createdAt: '2026-04-24T08:00:00.000Z',
      },
      { behavior: 'allow', remember: true },
    );

    expect(interactionRows).toHaveLength(1);
    expect(interactionRows[0]).toEqual(
      expect.objectContaining({
        sessionId: 7,
        toolUseId: 'tool-1',
        interactionKind: 'permission',
        decision: 'approved_always',
        remember: true,
      }),
    );
    expect(summary).toEqual(
      expect.objectContaining({
        decisionLabel: 'Always allow',
        decisionTone: 'ok',
      }),
    );
    expect((service as any).ensureRuntimeState(7).liveItems[0]).toEqual(
      expect.objectContaining({
        interaction: expect.objectContaining({
          decisionLabel: 'Always allow',
        }),
      }),
    );
  });

  it('hydrates persisted ask-user-question answers into history', async () => {
    interactionRows.push({
      id: 1,
      sessionId: 7,
      toolUseId: 'tool-ask-1',
      toolName: 'AskUserQuestion',
      interactionKind: 'ask_user_question',
      decision: 'answered',
      remember: false,
      responseContent: JSON.stringify({
        answers: {
          'Which approach should we use?': 'Option A',
        },
      }),
      requestSnapshot: JSON.stringify({
        input: {
          questions: [
            {
              question: 'Which approach should we use?',
            },
          ],
        },
      }),
      createdAt: '2026-04-24T08:00:00.000Z',
      resolvedAt: '2026-04-24T08:00:05.000Z',
    });

    (getSessionMessages as jest.Mock).mockResolvedValue([
      {
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-04-24T08:00:01.000Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-ask-1',
              name: 'AskUserQuestion',
              input: {
                questions: [{ question: 'Which approach should we use?' }],
              },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-04-24T08:00:05.000Z',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-ask-1',
              content: 'User has answered your questions.',
              is_error: false,
            },
          ],
        },
      },
    ]);

    const history = await service.getHistory(7);

    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_use',
          toolUseId: 'tool-ask-1',
          interaction: expect.objectContaining({
            kind: 'ask_user_question',
            decisionLabel: 'Answered',
            answers: [
              {
                question: 'Which approach should we use?',
                answer: 'Option A',
              },
            ],
          }),
        }),
      ]),
    );
  });

  describe('background work', () => {
    const SESSION_ID = 7;

    function startSubagent(agentId: string, agentType = 'Explore') {
      (service as any).upsertBackgroundWork(SESSION_ID, {
        id: `subagent:${agentId}`,
        kind: 'subagent',
        label: agentType,
      });
    }

    function backgroundIds(): string[] {
      const state = (service as any).runtimeStates.get(SESSION_ID);
      return (state?.backgroundWork ?? []).map((item: any) => item.id);
    }

    function ageItem(id: string, ms: number) {
      const state = (service as any).runtimeStates.get(SESSION_ID);
      const item = state.backgroundWork.find((entry: any) => entry.id === id);
      const stamp = new Date(Date.now() - ms).toISOString();
      item.updatedAt = stamp;
      item.startedAt = stamp;
    }

    it('reports a started subagent as active background work', () => {
      startSubagent('agent-1');

      expect((service as any).isBackgroundWorkLive(SESSION_ID)).toBe(true);
      expect((service as any).shouldQueueBehindBackground(SESSION_ID)).toBe(true);
      expect(backgroundIds()).toEqual(['subagent:agent-1']);
    });

    it('clears background work once the subagent stops', () => {
      startSubagent('agent-1');
      (service as any).clearBackgroundWork(SESSION_ID, 'subagent:agent-1');

      expect((service as any).isBackgroundWorkLive(SESSION_ID)).toBe(false);
      expect(backgroundIds()).toEqual([]);
    });

    // Regression: a dropped SubagentStop hook used to pin the session as
    // "background busy" forever, which silently queued every later prompt.
    // Quiet work must stop blocking the queue...
    it('stops queueing prompts behind background work that has gone quiet', () => {
      startSubagent('agent-1');
      ageItem('subagent:agent-1', 10 * 60 * 1000);

      expect((service as any).shouldQueueBehindBackground(SESSION_ID)).toBe(false);
    });

    // ...but must NOT release the runtime. Nothing the SDK emits carries an
    // agent_id, so silence is not evidence a background agent has finished, and
    // retiring the process on that basis is what destroys its work and leaves
    // Claude Code reporting "no completion record" on the next resume.
    it('keeps the runtime alive for quiet background work', () => {
      startSubagent('agent-1');
      ageItem('subagent:agent-1', 30 * 60 * 1000);

      expect((service as any).isBackgroundWorkLive(SESSION_ID)).toBe(true);
      expect(backgroundIds()).toEqual(['subagent:agent-1']);
    });

    it('retires background work only past the hard age ceiling', () => {
      startSubagent('agent-1');
      ageItem('subagent:agent-1', 7 * 60 * 60 * 1000);

      expect((service as any).isBackgroundWorkLive(SESSION_ID)).toBe(false);
      expect(backgroundIds()).toEqual([]);
    });

    // Regression: background work runs inside the runtime subprocess, so when
    // that process dies the work is gone whether or not stop hooks arrived.
    it('drops all background work when the runtime closes', () => {
      startSubagent('agent-1');
      startSubagent('agent-2');

      (service as any).clearAllBackgroundWork(SESSION_ID, 'runtime_closed');

      expect((service as any).isBackgroundWorkLive(SESSION_ID)).toBe(false);
      expect(backgroundIds()).toEqual([]);
    });

    it('only tracks tasks the SDK marks as backgrounded', () => {
      (service as any).syncTaskBackgroundWork(SESSION_ID, {
        taskId: 'task-fg',
        status: 'running',
        isBackgrounded: false,
        updatedAt: new Date().toISOString(),
      });
      expect(backgroundIds()).toEqual([]);

      (service as any).syncTaskBackgroundWork(SESSION_ID, {
        taskId: 'task-bg',
        status: 'running',
        description: 'Audit the repo',
        isBackgrounded: true,
        updatedAt: new Date().toISOString(),
      });
      expect(backgroundIds()).toEqual(['task:task-bg']);

      (service as any).syncTaskBackgroundWork(SESSION_ID, {
        taskId: 'task-bg',
        status: 'completed',
        isBackgrounded: true,
        updatedAt: new Date().toISOString(),
      });
      expect(backgroundIds()).toEqual([]);
    });

    // Regression: a `run_in_background` agent outlives the result of the turn
    // that launched it, and its task-kind counterpart is not yet marked
    // backgrounded at that point (is_backgrounded only ever arrives on a later
    // task_updated). Pruning on result would drop the last thing keeping the
    // process alive for it.
    it('keeps background work across the end of a run', () => {
      startSubagent('agent-1');

      (service as any).finishRun(SESSION_ID);

      expect(backgroundIds()).toEqual(['subagent:agent-1']);
      expect((service as any).isBackgroundWorkLive(SESSION_ID)).toBe(true);
    });

    // Regression: after a background resume finished, a stray late 'running'
    // from the SDK set runPhase with no run to own it — no result and no
    // watchdog could ever clear it, so the session stuck on "running" and the
    // user had to hit Stop before they could talk to it again.
    it('ignores a session state of running when no run owns it', () => {
      const state = (service as any).ensureRuntimeState(SESSION_ID);
      startSubagent('agent-1');
      state.runPhase = 'idle';

      (service as any).handleSessionStateChangedMessage(SESSION_ID, {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'running',
      });

      expect(state.runPhase).toBe('idle');
    });

    // Regression: task bookkeeping routinely trails the result of the turn that
    // just ended, so treating it as a wake-up spawned a second background run
    // that nothing would ever close.
    it('does not start a background run from task bookkeeping alone', () => {
      startSubagent('agent-1');
      const state = (service as any).ensureRuntimeState(SESSION_ID);
      state.runPhase = 'idle';

      (service as any).reconcileBackgroundResume(SESSION_ID, {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-1',
        patch: { status: 'completed' },
      });

      expect((service as any).activeRuns.has(SESSION_ID)).toBe(false);
      expect(state.runPhase).toBe('idle');
    });

    // The SDK reporting idle is authoritative that the agent loop concluded, so
    // it closes a background run even if we never see its result message.
    it('ends a background run when the SDK reports the session idle', () => {
      const state = (service as any).ensureRuntimeState(SESSION_ID);
      state.runPhase = 'running';
      state.canInterrupt = true;
      (service as any).activeRuns.set(SESSION_ID, {
        isBackground: true,
        runId: 'bg-test',
        startedAtMs: Date.now(),
        permissionRequests: new Map(),
        permissionRequestOrder: [],
        resolveCompletion: jest.fn(),
      });

      (service as any).handleSessionStateChangedMessage(SESSION_ID, {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      });

      expect((service as any).activeRuns.has(SESSION_ID)).toBe(false);
      expect(state.runPhase).toBe('idle');
      expect(state.canInterrupt).toBe(false);
    });

    it('emits background work on the event stream', () => {
      const events: any[] = [];
      service.on('event', (event: any) => events.push(event));

      startSubagent('agent-1', 'Plan');

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'background_work',
            payload: expect.objectContaining({
              sessionId: SESSION_ID,
              backgroundWork: [
                expect.objectContaining({
                  id: 'subagent:agent-1',
                  kind: 'subagent',
                  label: 'Plan',
                }),
              ],
            }),
          }),
        ]),
      );
    });

    // Regression: prompts queued behind background work drained only from the
    // tail of a user-submitted run, so they sat there until the next manual
    // send once the background path completed.
    it('drains a queued prompt once background work clears', async () => {
      const state = (service as any).ensureRuntimeState(SESSION_ID);
      startSubagent('agent-1');
      state.pendingPrompts = [
        { id: 'p1', prompt: 'queued while busy', queuedAt: new Date().toISOString() },
      ];
      const submitPrompt = jest
        .spyOn(service, 'submitPrompt')
        .mockResolvedValue(undefined);

      (service as any).drainPendingPrompts(SESSION_ID);
      expect(submitPrompt).not.toHaveBeenCalled();

      (service as any).clearBackgroundWork(SESSION_ID, 'subagent:agent-1');
      await new Promise((resolve) => setImmediate(resolve));

      expect(submitPrompt).toHaveBeenCalledWith(
        SESSION_ID,
        'queued while busy',
        undefined,
        undefined,
      );
      expect(state.pendingPrompts).toEqual([]);
    });

    // Regression: is_backgrounded only ever arrives on a later task_updated,
    // so a subagent that never receives one (or whose SubagentStop hook lacks
    // a well-formed agent_id/agent_type) showed up in the tasks drawer but
    // never in the background-agent bar. Capturing run_in_background from the
    // originating Agent tool_use closes that gap.
    it('marks a task backgrounded immediately from its run_in_background tool call', async () => {
      await (service as any).handleSdkMessage(SESSION_ID, {
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: 'claude-session-1',
        message: {
          id: 'assistant-msg-1',
          content: [
            {
              type: 'tool_use',
              id: 'tool-agent-1',
              name: 'Agent',
              input: {
                description: 'Explore',
                prompt: 'find things',
                run_in_background: true,
              },
            },
          ],
        },
      });

      await (service as any).handleSdkMessage(SESSION_ID, {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-bg-1',
        description: 'Explore',
        tool_use_id: 'tool-agent-1',
        uuid: 'task-start-1',
        session_id: 'claude-session-1',
      });

      expect(backgroundIds()).toEqual(['task:task-bg-1']);
    });

    it('does not background a task whose tool call did not request run_in_background', async () => {
      await (service as any).handleSdkMessage(SESSION_ID, {
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: 'claude-session-1',
        message: {
          id: 'assistant-msg-1',
          content: [
            {
              type: 'tool_use',
              id: 'tool-agent-1',
              name: 'Agent',
              input: { description: 'Explore', prompt: 'find things' },
            },
          ],
        },
      });

      await (service as any).handleSdkMessage(SESSION_ID, {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-fg-1',
        description: 'Explore',
        tool_use_id: 'tool-agent-1',
        uuid: 'task-start-1',
        session_id: 'claude-session-1',
      });

      expect(backgroundIds()).toEqual([]);
    });

    // Regression: the SubagentStop/TaskCompleted hook (HTTP) and the SDK
    // message reporting the result (subprocess stdout) are independent
    // transports with no ordering guarantee. If the hook wins the race and
    // clears backgroundWork first, reconcileBackgroundResume used to find no
    // live work and skip flipping the session back to "running" — leaving the
    // UI stuck on idle while Claude was actively producing output.
    it('still starts a background run when the resume message arrives just after backgroundWork was cleared', () => {
      (service as any).sessionRuntimes.set(SESSION_ID, {});
      const state = (service as any).ensureRuntimeState(SESSION_ID);
      state.runPhase = 'idle';
      startSubagent('agent-1');

      (service as any).clearBackgroundWork(SESSION_ID, 'subagent:agent-1');
      expect(backgroundIds()).toEqual([]);

      (service as any).reconcileBackgroundResume(SESSION_ID, {
        type: 'assistant',
        uuid: 'assistant-resume-1',
        session_id: 'claude-session-1',
        message: { id: 'assistant-resume-1', content: [] },
      });

      expect(state.runPhase).toBe('running');
      expect((service as any).activeRuns.has(SESSION_ID)).toBe(true);
    });

    it('does not start a background run once the resume grace window has elapsed', () => {
      (service as any).sessionRuntimes.set(SESSION_ID, {});
      const state = (service as any).ensureRuntimeState(SESSION_ID);
      state.runPhase = 'idle';
      startSubagent('agent-1');

      (service as any).clearBackgroundWork(SESSION_ID, 'subagent:agent-1');
      state.lastBackgroundWorkFinishedAtMs = Date.now() - 60 * 1000;

      (service as any).reconcileBackgroundResume(SESSION_ID, {
        type: 'assistant',
        uuid: 'assistant-resume-1',
        session_id: 'claude-session-1',
        message: { id: 'assistant-resume-1', content: [] },
      });

      expect(state.runPhase).toBe('idle');
      expect((service as any).activeRuns.has(SESSION_ID)).toBe(false);
    });

    // Regression: canUseTool read activeRuns directly and auto-denied any
    // permission RPC that arrived before reconcileBackgroundResume (or after
    // finishRun already retired the run) had registered one — the CLI's own
    // "question tools automatically declined and couldn't be answered" bug.
    it('answers a permission request on a resumed run instead of auto-denying it', async () => {
      (service as any).sessionRuntimes.set(SESSION_ID, {});
      const state = (service as any).ensureRuntimeState(SESSION_ID);
      state.runPhase = 'idle';

      const canUseTool = (service as any).createCanUseTool(SESSION_ID, state);
      const decision = canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tool-1',
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect((service as any).activeRuns.has(SESSION_ID)).toBe(true);
      const run = (service as any).activeRuns.get(SESSION_ID);
      expect(run.permissionRequests.size).toBe(1);
      const pending = [...run.permissionRequests.values()][0];
      pending.resolve({ behavior: 'allow' });

      const result = await decision;
      expect(result.behavior).toBe('allow');
    });

    it('denies a permission request when the runtime is gone entirely', async () => {
      const state = (service as any).ensureRuntimeState(SESSION_ID);
      state.runPhase = 'idle';

      const canUseTool = (service as any).createCanUseTool(SESSION_ID, state);
      const result = await canUseTool('Bash', { command: 'ls' }, {
        toolUseID: 'tool-1',
      });

      expect(result.behavior).toBe('deny');
      expect((service as any).activeRuns.has(SESSION_ID)).toBe(false);
    });

    // Same bug, on the elicitation RPC path used for MCP user-input prompts
    // (e.g. AskUserQuestion-style flows): a resumed run with no activeRuns
    // entry used to auto-decline instead of surfacing an answerable request.
    it('surfaces an elicitation request on a resumed run instead of auto-declining it', async () => {
      (service as any).sessionRuntimes.set(SESSION_ID, {});
      const state = (service as any).ensureRuntimeState(SESSION_ID);
      state.runPhase = 'idle';

      const onElicitation = (service as any).createOnElicitation(
        SESSION_ID,
        state,
      );
      const decision = onElicitation({
        serverName: 'linear',
        message: 'Authenticate Linear',
        mode: 'url',
        url: 'https://auth.example.com/authorize',
        elicitationId: 'elicit-1',
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect((service as any).activeRuns.has(SESSION_ID)).toBe(true);
      const run = (service as any).activeRuns.get(SESSION_ID);
      expect(run.userInputRequests.size).toBe(1);
      const pending = [...run.userInputRequests.values()][0];
      pending.resolve({ action: 'accept' });

      const result = await decision;
      expect(result).toEqual({ action: 'accept' });
      expect(state.runPhase).toBe('waiting');
    });

    it('declines an elicitation request when the runtime is gone entirely', async () => {
      const state = (service as any).ensureRuntimeState(SESSION_ID);
      state.runPhase = 'idle';

      const onElicitation = (service as any).createOnElicitation(
        SESSION_ID,
        state,
      );
      const result = await onElicitation({
        serverName: 'linear',
        message: 'Authenticate Linear',
        mode: 'url',
        url: 'https://auth.example.com/authorize',
        elicitationId: 'elicit-2',
      });

      expect(result).toEqual({ action: 'decline' });
      expect((service as any).activeRuns.has(SESSION_ID)).toBe(false);
    });
  });
});
