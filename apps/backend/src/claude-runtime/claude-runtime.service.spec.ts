import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as module_ from 'module';
import * as runtimePaths from '../config/runtime-paths.js';
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSubagentMessages: jest.fn(),
  getSessionMessages: jest.fn(),
  query: jest.fn(),
}));
import {
  getSessionMessages,
  getSubagentMessages,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudeRuntimeService, loadClaudeSdkPackageMetadata } from './claude-runtime.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { TerminalService } from '../terminal/terminal.service.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

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
                row.sessionId === value.sessionId
                && row.toolUseId === value.toolUseId,
            );
            const nextRow = {
              id: existingIndex >= 0 ? interactionRows[existingIndex].id : interactionRows.length + 1,
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaudeRuntimeService,
        { provide: DRIZZLE, useValue: db },
        { provide: SessionsService, useValue: sessionsService },
        { provide: ClaudeHooksService, useValue: hooksService },
        { provide: TerminalService, useValue: terminalService },
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
    jest.spyOn(runtimePaths, 'getBackendRuntimeRoot').mockReturnValue('/tmp/elevenex-runtime');
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('missing');
    });
    jest.spyOn(module_, 'createRequire').mockImplementation(() => ({
      resolve: () => {
        throw new Error('missing');
      },
    }) as unknown as NodeJS.Require);

    expect(loadClaudeSdkPackageMetadata()).toEqual({ version: 'unknown' });
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

  it('publishes sidebar activity for running, action, resumed, and idle runtime states', () => {
    const state = (service as any).ensureRuntimeState(7);
    const emittedEvents: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    service.on('event', (event: { type: string; payload?: Record<string, unknown> }) =>
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

    const runStates = emittedEvents.filter((event) => event.type === 'run_state');
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
      authUrl: 'https://auth.example.com/authorize?client_id=claude-code&redirect_uri=http%3A%2F%2Flocalhost%3A49152%2Fcallback&state=abc',
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

      expect(query).toHaveBeenCalledWith(expect.objectContaining({
        options: expect.objectContaining({
          cwd: '/tmp/project',
          persistSession: false,
          settingSources: ['project', 'user', 'local'],
        }),
      }));
      expect(mcpAuthenticate).toHaveBeenCalledWith('linear');
      expect(close).toHaveBeenCalled();
    } finally {
      (query as jest.Mock).mockReset();
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
      .mockImplementation(async (targetPath: string) =>
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
    const labels = items.map((item) => `${item.trigger}:${item.label}:${item.detail ?? ''}`);

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
    const emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    service.on('event', (event: { type: string; payload: Record<string, unknown> }) =>
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
    expect(loggerDebugSpy).toHaveBeenCalledWith(
      'Claude stream event session=7 type=content_block_start',
    );
    expect(loggerDebugSpy).toHaveBeenCalledWith(
      'Claude stream event session=7 type=content_block_delta delta=text_delta',
    );
  });

  it('correlates stream deltas using message_start.message.id instead of wrapper event uuid', async () => {
    const emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    service.on('event', (event: { type: string; payload: Record<string, unknown> }) =>
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
    const emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    service.on('event', (event: { type: string; payload: Record<string, unknown> }) =>
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
    const assistantItems = state.liveItems.filter((item) => item.kind === 'assistant');

    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0]).toEqual(
      expect.objectContaining({
        id: 'assistant-msg-99:0',
        content: 'Hello world',
      }),
    );
    expect((service as any).activeRuns.get(7).partialAssistantItems.size).toBe(0);
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
    const assistantItems = state.liveItems.filter((item) => item.kind === 'assistant');
    const thinkingItems = state.liveItems.filter((item) => item.kind === 'thinking');

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
    expect((service as any).activeRuns.get(7).partialAssistantItems.size).toBe(0);
  });

  it('uses the SDK-managed Claude CLI by default when submitting prompts', async () => {
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
        next: async () => ({ done: true, value: undefined }),
      }),
    });

    await service.submitPrompt(7, 'Stream this');

    expect(query).toHaveBeenCalledTimes(1);
    expect((query as jest.Mock).mock.calls[0][0].options).not.toHaveProperty(
      'pathToClaudeCodeExecutable',
    );
  });

  it('generates a Haiku title for the first prompt of an auto-named session', async () => {
    sessionsService.findOne.mockResolvedValue({
      id: 7,
      name: 'Session 7',
      worktreePath: '/tmp/project',
      claudeSessionId: '-1',
    });
    const runtimeClose = jest.fn();
    const titleClose = jest.fn();
    (query as jest.Mock).mockImplementation(({ prompt }) => {
      const isTitleQuery = String(prompt).includes('Name this Claude Code session');
      return {
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
        close: isTitleQuery ? titleClose : runtimeClose,
        [Symbol.asyncIterator]: () => {
          let emitted = false;
          return {
            next: async () => {
              if (!isTitleQuery) {
                return { done: true, value: undefined };
              }

              if (emitted) {
                return { done: true, value: undefined };
              }
              emitted = true;
              return {
                done: false,
                value: {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: 'Implement Auto Names' }],
                  },
                },
              };
            },
          };
        },
      };
    });

    await service.submitPrompt(7, 'Please implement auto names', 'Please implement auto names');
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(query).toHaveBeenCalledTimes(2);
    expect((query as jest.Mock).mock.calls[1][0]).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({
          model: 'haiku',
          maxTurns: 1,
          permissionMode: 'plan',
          cwd: '/tmp/project',
        }),
      }),
    );
    expect((query as jest.Mock).mock.calls[1][0].prompt).toContain(
      'Respond promptly with a broad short title',
    );
    expect(sessionsService.renameFromGeneratedTitle).toHaveBeenCalledWith(
      7,
      'Implement Auto Names',
    );
    expect(titleClose).toHaveBeenCalled();
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
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
      }),
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
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
      }),
    });

    await service.submitPrompt(7, 'Start this');
    await new Promise((resolve) => setImmediate(resolve));

    expect(query).toHaveBeenCalledTimes(1);
    expect(sessionsService.renameFromGeneratedTitle).not.toHaveBeenCalled();
  });

  it('normalizes generated titles to five words without markdown or punctuation', () => {
    expect(
      (service as any).normalizeGeneratedSessionTitle(
        '```text\n"Implement Auto Session Names Quickly Now Please!"\n```',
      ),
    ).toBe('Implement Auto Session Names Quickly');
  });

  it('leaves the session name unchanged when Haiku title generation fails', async () => {
    sessionsService.findOne.mockResolvedValue({
      id: 7,
      name: 'Session 7',
      worktreePath: '/tmp/project',
      claudeSessionId: '-1',
    });
    (query as jest.Mock).mockImplementation(({ prompt }) => {
      const isTitleQuery = String(prompt).includes('Name this Claude Code session');
      return {
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
            if (isTitleQuery) {
              throw new Error('title failed');
            }
            return { done: true, value: undefined };
          },
        }),
      };
    });

    await service.submitPrompt(7, 'Start this');
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(sessionsService.renameFromGeneratedTitle).not.toHaveBeenCalled();
  });

  it('does not block the first Claude stream event on initial metadata refresh', async () => {
    let resolveModels: ((value: unknown[]) => void) | null = null;
    let resolveUsage:
      ((value: {
        model: string;
        totalTokens: number;
        maxTokens: number;
        percentage: number;
        apiUsage: undefined;
        autoCompactThreshold: number;
        isAutoCompactEnabled: boolean;
        memoryFiles: never[];
        mcpTools: never[];
      }) => void) | null = null;
    let emitted = false;
    let releaseIterator: (() => void) | null = null;

    const emittedEvents: string[] = [];
    service.on('event', (event: { type: string }) => emittedEvents.push(event.type));

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
          return { done: true, value: undefined };
        },
      }),
    });

    const submitPromise = service.submitPrompt(7, 'Start streaming');
    await new Promise((resolve) => setImmediate(resolve));

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
      ((value: {
        model: string;
        totalTokens: number;
        maxTokens: number;
        percentage: number;
        apiUsage: undefined;
        autoCompactThreshold: number;
        isAutoCompactEnabled: boolean;
        memoryFiles: never[];
        mcpTools: never[];
      }) => void) | null = null;

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

    const first = (service as any).refreshRuntimeMetadata(7, { reason: 'test' });
    const second = (service as any).refreshRuntimeMetadata(7, { reason: 'test' });

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

    const debugMessages = loggerDebugSpy.mock.calls.map(([message]) => String(message));
    expect(debugMessages.some((message) => message.includes('stage=submit_start'))).toBe(true);
    expect(debugMessages.some((message) => message.includes('stage=runtime_query_created'))).toBe(true);
    expect(debugMessages.some((message) => message.includes('stage=resume_diagnostics'))).toBe(true);
    expect(debugMessages.some((message) => message.includes('stage=first_sdk_message:system'))).toBe(true);
    expect(debugMessages.some((message) => message.includes('stage=pre_visible_system:init'))).toBe(true);
    expect(debugMessages.some((message) => message.includes('stage=first_visible_message_start'))).toBe(true);
    expect(debugMessages.some((message) => message.includes('preVisibleSummary'))).toBe(true);
    expect(debugMessages.some((message) => message.includes('stage=run_complete'))).toBe(true);
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

    const options = (overrideService as any).buildQueryOptions(
      7,
      '/tmp/project',
      'claude-session-1',
      null,
      null,
      jest.fn(),
      jest.fn(),
    );

    expect(options.pathToClaudeCodeExecutable).toBe('/custom/bin/claude');
  });

  it('warns when ELEVENEX_CLAUDE_BIN version does not match SDK parity', () => {
    const overrideService = Object.assign(
      Object.create(Object.getPrototypeOf(service)),
      service,
      {
        claudeCliOverride: {
          path: '/custom/bin/claude',
          version: '2.1.81 (Claude Code)',
        },
      },
    ) as ClaudeRuntimeService;

    (overrideService as any).logClaudeRuntimeConfiguration();

    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Claude CLI override version mismatch: sdk expects 2.1.118, override reports 2.1.81 (Claude Code).',
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
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'README.md' } },
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
      .mockResolvedValue('/tmp/.claude/projects/project/claude-session-1.jsonl');
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

  it('falls back to transcript records when SDK history lookup throws', async () => {
    (getSessionMessages as jest.Mock).mockRejectedValue(new Error('lookup failed'));
    jest
      .spyOn(service as never, 'findTranscriptPath' as never)
      .mockResolvedValue('/tmp/.claude/projects/project/claude-session-1.jsonl');
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
          { type: 'tool_use', id: 'child-tool-1', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
    });

    await (service as any).handleSdkMessage(7, {
      type: 'user',
      uuid: 'user-parented-1',
      session_id: 'claude-session-1',
      parent_tool_use_id: 'agent-tool-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'child-tool-1', content: 'done', is_error: false }],
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
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'README.md' } },
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
    service.on('event', (event: { type: string }) => emittedEvents.push(event.type));

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
    service.on('event', (event: { type: string }) => emittedEvents.push(event.type));

    (service as any).activeRuns.set(7, {
      query: { interrupt, close },
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map([
        [
          'perm-1',
          {
            request: { requestId: 'perm-1', toolName: 'Edit', input: {}, createdAt: 'now' },
            resolve: resolvePermission,
          },
        ],
        [
          'perm-2',
          {
            request: { requestId: 'perm-2', toolName: 'Bash', input: {}, createdAt: 'later' },
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
    expect(close).toHaveBeenCalled();
    expect(runtimeState.pendingPermissionRequest).toBeNull();
    expect(runtimeState.canInterrupt).toBe(false);
    expect(runtimeState.runPhase).toBe('idle');
    expect(emittedEvents).toContain('run_state');
  });

  it('promotes queued permission requests in order after the current one resolves', async () => {
    const emittedEvents: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    service.on('event', (event: { type: string; payload?: Record<string, unknown> }) =>
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
            request: { requestId: 'perm-1', toolName: 'Edit', input: {}, createdAt: 'now' },
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
          event.type === 'permission_request'
          && event.payload?.['request']
          && (event.payload['request'] as { requestId?: string }).requestId === 'perm-2',
      ),
    ).toBe(true);
  });

  it('clears stale pending permission when a resolved tool result arrives', () => {
    const emittedEvents: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    service.on('event', (event: { type: string; payload?: Record<string, unknown> }) =>
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
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'accepted' }],
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
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'accepted' }],
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
            request: { requestId: 'input-1', message: 'Continue?', createdAt: 'now' },
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
    expect(close).toHaveBeenCalled();
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
    await expect(service.getSubagentHistory(7, 'missing-agent')).rejects.toThrow(
      'Subagent not found for this session.',
    );
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
});
