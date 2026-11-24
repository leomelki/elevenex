import { AntigravityBackground } from './antigravity-background.js';

describe('Antigravity background work', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps a scheduled wake open for its advertised duration', async () => {
    const work = new AntigravityBackground();
    work.observe({
      sessionUpdate: 'tool_call',
      toolCallId: 'schedule',
      title: 'Run schedule',
      kind: 'other',
      status: 'in_progress',
      rawInput: { DurationSeconds: 3600 },
    });
    const completed = jest.fn();
    const settling = work
      .settle(new AbortController().signal, () => false)
      .then(completed);
    await jest.advanceTimersByTimeAsync(61 * 60_000);
    expect(completed).not.toHaveBeenCalled();
    expect(work.items).toMatchObject([{ id: 'task:schedule' }]);
    work.observe({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'schedule',
      status: 'completed',
    });
    work.replyStarted();
    work.replyEnded();
    await settling;
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('renewes the hold only for the command that reports progress', async () => {
    const work = new AntigravityBackground();
    work.observe({
      sessionUpdate: 'tool_call',
      toolCallId: 'command',
      kind: 'execute',
      status: 'in_progress',
    });
    const completed = jest.fn();
    const settling = work
      .settle(new AbortController().signal, () => false)
      .then(completed);
    await jest.advanceTimersByTimeAsync(20 * 60_000);
    work.observe({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'command',
      status: 'in_progress',
    });
    await jest.advanceTimersByTimeAsync(20 * 60_000);
    expect(completed).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await settling;
    expect(work.finished).toMatchObject([
      { taskId: 'command', status: 'unavailable' },
    ]);
  });
});
