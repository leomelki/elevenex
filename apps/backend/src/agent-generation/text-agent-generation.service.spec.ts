import {
  readCodexExecAgentMessage,
  readCodexExecError,
  TextAgentGenerationService,
} from './text-agent-generation.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { PiSessionRuntime } from '../pi-runtime/pi-session-runtime.js';

describe('TextAgentGenerationService model selection', () => {
  const getAgentProviderDefaults = jest.fn((provider: string) => ({
    model: `${provider}-user-default`,
    reasoningEffort: 'high',
  }));
  const service = new TextAgentGenerationService({
    getAgentProviderDefaults,
  } as unknown as SettingsService);

  beforeEach(() => {
    getAgentProviderDefaults.mockImplementation((provider: string) => ({
      model: `${provider}-user-default`,
      reasoningEffort: 'high',
    }));
  });

  it('uses the model selected by the user', () => {
    expect((service as any).resolveModel('codex')).toBe('codex-user-default');
    expect((service as any).resolveModel('pi')).toBe('pi-user-default');
  });

  it('defers to the provider when the user has not selected a model', () => {
    getAgentProviderDefaults.mockReturnValueOnce({
      model: null,
      reasoningEffort: null,
    });

    expect((service as any).resolveModel('codex')).toBeNull();
  });

  it('keeps an explicit model override', () => {
    expect((service as any).resolveModel('codex', 'temporary-model')).toBe(
      'temporary-model',
    );
  });

  it('selects the user default model and low reasoning for Pi one-shot tasks', async () => {
    getAgentProviderDefaults.mockReturnValueOnce({
      model: 'provider/user-selected-pi-model',
      reasoningEffort: 'high',
    });
    const send = jest
      .spyOn(PiSessionRuntime.prototype, 'send')
      .mockImplementation(function (this: PiSessionRuntime, command: any) {
        if (command.type === 'prompt') {
          setImmediate(() => this.emit('event', { type: 'agent_end' }));
        }
        return Promise.resolve(undefined as never);
      });
    const stop = jest
      .spyOn(PiSessionRuntime.prototype, 'stop')
      .mockResolvedValue();

    await service.generate({
      provider: 'pi',
      worktreePath: '/repo',
      prompt: 'Generate text',
      taskName: 'test',
    });

    expect(send).toHaveBeenNthCalledWith(1, {
      type: 'set_model',
      provider: 'provider',
      modelId: 'user-selected-pi-model',
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: 'prompt',
      message: 'Generate text',
      reasoningEffort: 'low',
    });
    stop.mockRestore();
    send.mockRestore();
  });
});

describe('readCodexExecAgentMessage', () => {
  it('extracts completed assistant output from the CLI JSONL stream', () => {
    expect(
      readCodexExecAgentMessage(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Generated title' },
        }),
      ),
    ).toBe('Generated title');
  });

  it('ignores other events and non-JSON diagnostic output', () => {
    expect(
      readCodexExecAgentMessage(JSON.stringify({ type: 'turn.completed' })),
    ).toBeNull();
    expect(readCodexExecAgentMessage('warning: retrying')).toBeNull();
  });
});

describe('readCodexExecError', () => {
  it('extracts top-level and failed-turn errors from the CLI JSONL stream', () => {
    expect(
      readCodexExecError(
        JSON.stringify({ type: 'error', message: 'Authentication failed' }),
      ),
    ).toBe('Authentication failed');
    expect(
      readCodexExecError(
        JSON.stringify({
          type: 'turn.failed',
          error: { message: 'Model unavailable' },
        }),
      ),
    ).toBe('Model unavailable');
  });

  it('ignores unrelated and malformed lines', () => {
    expect(
      readCodexExecError(JSON.stringify({ type: 'turn.started' })),
    ).toBeNull();
    expect(readCodexExecError('not json')).toBeNull();
  });
});
