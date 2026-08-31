import { AntigravityRuntimeService } from './antigravity-runtime.service.js';
import type {
  AntigravityResultEvent,
  AntigravityRuntimeState,
  AntigravityStreamEvent,
} from './antigravity-runtime.types.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';

const SESSION_ID = 7;

/**
 * Streams replayed here are verbatim from a live `agy` 1.1.22 session driven
 * over `--input-format stream-json --output-format stream-json`, minus the
 * envelope nesting that `AntigravityProcessClient.handleLine` strips before
 * these handlers ever see an event (that unwrapping is covered by
 * `antigravity-process-client.spec.ts`).
 */
function stepUpdate(payload: Record<string, unknown>): AntigravityStreamEvent {
  return { type: 'step_update', ...payload };
}

function makeService(): {
  service: AntigravityRuntimeService;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const sessionsService = {
    findOne: jest.fn(),
    updateStatus: jest.fn(),
    updateAntigravitySessionId: jest.fn().mockResolvedValue(undefined),
    renameFromGeneratedTitle: jest.fn(),
  };
  const authService = { getStatus: jest.fn(), getRuntimeEnv: () => ({}) };
  const mcpService = { getSnapshot: jest.fn() };
  const hooksService = { updateRuntimeActivity: jest.fn() };
  const titleService = { generate: jest.fn() };
  const settingsService = { getAgentProviderDefaults: () => ({}) };

  const service = new AntigravityRuntimeService(
    sessionsService as never,
    authService as never,
    mcpService as never,
    hooksService as never,
    titleService as never,
    settingsService as never,
  );

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  service.on(
    'event',
    (event: { type: string; payload: Record<string, unknown> }) =>
      events.push(event),
  );
  return { service, events };
}

/** Drives the private stream handler the way the process client would. */
function feed(
  service: AntigravityRuntimeService,
  events: AntigravityStreamEvent[],
): void {
  for (const event of events) {
    (
      service as unknown as {
        handleStepEvent: (id: number, event: AntigravityStreamEvent) => void;
      }
    ).handleStepEvent(SESSION_ID, event);
  }
}

function finishTurn(
  service: AntigravityRuntimeService,
  result: Partial<AntigravityResultEvent> & { status: string },
): void {
  (
    service as unknown as {
      handleTurnResult: (id: number, result: AntigravityResultEvent) => void;
    }
  ).handleTurnResult(SESSION_ID, {
    type: 'result',
    ...result,
  });
}

function stateOf(service: AntigravityRuntimeService): AntigravityRuntimeState {
  return (
    service as unknown as {
      ensureRuntimeState: (id: number) => AntigravityRuntimeState;
    }
  ).ensureRuntimeState(SESSION_ID);
}

async function historyOf(
  service: AntigravityRuntimeService,
): Promise<ClaudeTranscriptItem[]> {
  return service.getHistory(SESSION_ID);
}

describe('AntigravityRuntimeService stream handling', () => {
  it('captures the conversation id from init so the thread can be resumed', () => {
    const { service } = makeService();
    feed(service, [
      {
        type: 'init',
        conversation_id: '221958ed-c934-4352-a715-39623149f9d2',
        cwd: '/ws',
      },
    ]);
    expect(stateOf(service).antigravitySessionId).toBe(
      '221958ed-c934-4352-a715-39623149f9d2',
    );
  });

  it('merges consecutive text deltas into one assistant message', async () => {
    const { service } = makeService();
    feed(service, [
      stepUpdate({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
      stepUpdate({
        step_index: 11,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: '### Files\n- `.git/`\n',
      }),
      stepUpdate({
        step_index: 11,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: '- README.md\n',
      }),
    ]);
    finishTurn(service, { status: 'SUCCESS', response: '### Files\n' });

    const history = await historyOf(service);
    const assistant = history.filter((item) => item.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe('### Files\n- `.git/`\n- README.md\n');
  });

  it('does not repeat streamed prose from result.response', async () => {
    const { service } = makeService();
    feed(service, [
      stepUpdate({
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'hello from agy.\n',
      }),
    ]);
    // `agy` streams the prose and then repeats the whole thing in the result.
    finishTurn(service, { status: 'SUCCESS', response: 'hello from agy.\n' });

    const assistant = (await historyOf(service)).filter(
      (item) => item.kind === 'assistant',
    );
    expect(assistant).toHaveLength(1);
  });

  it('falls back to result.response when nothing streamed', async () => {
    const { service } = makeService();
    finishTurn(service, { status: 'SUCCESS', response: 'only in the result' });

    const assistant = (await historyOf(service)).filter(
      (item) => item.kind === 'assistant',
    );
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe('only in the result');
  });

  it('renders one card per tool call, correlated by step_index', async () => {
    const { service } = makeService();
    feed(service, [
      stepUpdate({
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: { AbsolutePath: '/ws/src/math.js' },
        },
      }),
      stepUpdate({
        step_index: 4,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: { AbsolutePath: '/ws/src/math.js' },
          output: '8 lines, 93 bytes',
        },
      }),
    ]);

    const history = await historyOf(service);
    const uses = history.filter((item) => item.kind === 'tool_use');
    const results = history.filter((item) => item.kind === 'tool_result');
    expect(uses).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].toolUseId).toBe(uses[0].toolUseId);
    expect(results[0].content).toBe('8 lines, 93 bytes');
    // The card renders as a Read, not as a raw `unknown` blob.
    expect(uses[0].toolKind).toBe('read');
    expect(uses[0].providerToolName).toBe('view_file');
    expect((uses[0].toolInput as { file_path?: string }).file_path).toBe(
      '/ws/src/math.js',
    );
  });

  it('marks a failed tool call as an error using the error object', async () => {
    const { service } = makeService();
    const parameters = { AbsolutePath: '/ws/src/does-not-exist.js' };
    feed(service, [
      stepUpdate({
        step_index: 14,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_info: { name: 'view_file', parameters },
      }),
      stepUpdate({
        step_index: 14,
        state: 'ERROR',
        step_type: 'tool',
        tool_info: {
          name: 'view_file',
          parameters,
          error: {
            type: 'TOOL_ERROR',
            message: 'failed to read file: no such file or directory',
          },
        },
      }),
    ]);

    const result = (await historyOf(service)).find(
      (item) => item.kind === 'tool_result',
    );
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain('no such file or directory');
  });

  it('closes the card for a tool that settles with neither output nor error', async () => {
    // What an auto-denied tool looks like: DONE, but nothing came back.
    const { service } = makeService();
    feed(service, [
      stepUpdate({
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } },
      }),
      stepUpdate({
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } },
      }),
    ]);

    const results = (await historyOf(service)).filter(
      (item) => item.kind === 'tool_result',
    );
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('');
  });

  it('starts a new message after a tool call rather than appending to the old one', async () => {
    const { service } = makeService();
    feed(service, [
      stepUpdate({
        step_index: 3,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'Let me look.\n',
      }),
      stepUpdate({
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_info: { name: 'view_file', parameters: { AbsolutePath: '/a' } },
      }),
      stepUpdate({
        step_index: 4,
        state: 'DONE',
        step_type: 'tool',
        tool_info: {
          name: 'view_file',
          parameters: { AbsolutePath: '/a' },
          output: '1 line',
        },
      }),
      stepUpdate({
        step_index: 5,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'It exports add.\n',
      }),
    ]);

    const assistant = (await historyOf(service)).filter(
      (item) => item.kind === 'assistant',
    );
    expect(assistant.map((item) => item.content)).toEqual([
      'Let me look.\n',
      'It exports add.\n',
    ]);
  });
});

describe('AntigravityRuntimeService turn outcomes', () => {
  const errorsFrom = (
    events: Array<{ type: string; payload: Record<string, unknown> }>,
  ) =>
    events
      .filter((event) => event.type === 'error')
      .map((event) => String(event.payload['message']));

  it('explains an empty turn as the headless auto-deny it almost always is', () => {
    const { service, events } = makeService();
    stateOf(service).permissionMode = 'default';
    // An auto-denied tool ends the turn SUCCESS with no response and no prose.
    finishTurn(service, { status: 'SUCCESS', response: '' });

    expect(errorsFrom(events)[0]).toContain('auto-denies tool calls');
  });

  it('does not blame permissions when the session already bypasses them', () => {
    const { service, events } = makeService();
    // bypassPermissions is the default for new sessions.
    expect(stateOf(service).permissionMode).toBe('bypassPermissions');
    finishTurn(service, { status: 'SUCCESS', response: '' });

    const message = errorsFrom(events)[0];
    expect(message).toContain('without producing any output');
    expect(message).not.toContain('auto-denies');
  });

  it('reports an unrequested CANCELED as a failure, not a clean stop', () => {
    const { service, events } = makeService();
    finishTurn(service, { status: 'CANCELED' });
    expect(errorsFrom(events)).toHaveLength(1);
  });

  it('treats the ERROR a SIGINT produces as the interrupt the user asked for', () => {
    const { service, events } = makeService();
    (
      service as unknown as {
        activeRuns: Map<number, { interruptRequested: boolean }>;
      }
    ).activeRuns.set(SESSION_ID, { interruptRequested: true });

    // Verified `agy` behavior: SIGINT aborts the request and reports this,
    // rather than CANCELED or INTERRUPTED.
    finishTurn(service, {
      status: 'ERROR',
      error: 'timeout waiting for response',
    });

    expect(errorsFrom(events)).toEqual([]);
    expect(events.some((event) => event.type === 'complete')).toBe(true);
    expect(stateOf(service).runPhase).toBe('idle');
  });

  it('still surfaces a genuine ERROR when no interrupt was requested', () => {
    const { service, events } = makeService();
    finishTurn(service, {
      status: 'ERROR',
      error: 'invalid model selection (--model "nope")',
    });
    expect(errorsFrom(events)[0]).toContain('invalid model selection');
  });

  it('reports a process exit during an interrupt as an interrupt', () => {
    const { service, events } = makeService();
    (
      service as unknown as {
        activeRuns: Map<number, { interruptRequested: boolean }>;
      }
    ).activeRuns.set(SESSION_ID, { interruptRequested: true });

    // SIGINT kills `agy`, so the exit lands here too.
    (
      service as unknown as {
        handleRuntimeExit: (
          id: number,
          details: { message?: string; stderr?: string },
        ) => void;
      }
    ).handleRuntimeExit(SESSION_ID, {
      message: 'Antigravity process exited with code 1',
    });

    expect(errorsFrom(events)).toEqual([]);
  });
});

describe('AntigravityRuntimeService spawn arguments', () => {
  const argsFor = (
    service: AntigravityRuntimeService,
    mutate: (state: AntigravityRuntimeState) => void = () => undefined,
  ) => {
    const state = stateOf(service);
    mutate(state);
    return (
      service as unknown as {
        resolveSpawnArgs: (
          state: AntigravityRuntimeState,
          worktreePath: string,
        ) => string[];
      }
    ).resolveSpawnArgs(state, '/ws');
  };

  it('always adds the worktree, since agy ignores its own cwd', () => {
    const { service } = makeService();
    expect(argsFor(service)).toEqual(
      expect.arrayContaining(['--add-dir', '/ws']),
    );
  });

  it('bypasses permissions by default, the only posture that can run tools', () => {
    const { service } = makeService();
    expect(argsFor(service)).toContain('--dangerously-skip-permissions');
  });

  it('resumes the session conversation when one is known', () => {
    const { service } = makeService();
    const args = argsFor(service, (state) => {
      state.antigravitySessionId = 'abc-123';
    });
    expect(args).toEqual(expect.arrayContaining(['--conversation', 'abc-123']));
  });

  it('omits the resume flag on a session that has never run', () => {
    const { service } = makeService();
    expect(argsFor(service)).not.toContain('--conversation');
  });

  it('maps plan mode onto --mode plan, ahead of the permission posture', () => {
    const { service } = makeService();
    const args = argsFor(service, (state) => {
      state.planMode = true;
    });
    expect(args).toEqual(expect.arrayContaining(['--mode', 'plan']));
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('passes model and effort through when set', () => {
    const { service } = makeService();
    const args = argsFor(service, (state) => {
      state.selectedModel = 'gemini-3.1-pro-high';
      state.reasoningEffort = 'high';
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '--model',
        'gemini-3.1-pro-high',
        '--effort',
        'high',
      ]),
    );
  });
});
