import { BrowserAgentPresentation, browserPresentationCommand } from '@elevenex/browser-agent';

describe('Task browser presentation boundary', () => {
  afterEach(() => jest.useRealTimers());
  it('validates bounded steps and cursor geometry without accepting arbitrary UI instructions', () => {
    for (const input of [
      { kind: 'step', step: { n: 0, text: 'Invalid' } },
      { kind: 'step', step: { n: 3, total: 2, text: 'Invalid' } },
      { kind: 'step', step: { n: 1, text: 'x'.repeat(401) } },
      { kind: 'step', step: { n: 1, text: 'Waiting', status: 'custom-html' } },
      { kind: 'cursor', point: { x: NaN, y: 1 } },
      { kind: 'cursor', point: { x: -1, y: 1 } },
      { kind: 'cursor', point: { x: 1, y: 1 }, pulse: 'forever' },
      { kind: 'cursor', point: { x: 1, y: 1 }, highlight: { x: 0, y: 0, width: 0, height: 20 } },
      { kind: 'hide-cursor', css: 'body{display:none}' },
    ]) expect(() => browserPresentationCommand(input)).toThrow();
    expect(browserPresentationCommand({ kind: 'step', step: { n: 1, text: 'Loading items', status: 'waiting' } })).toEqual({ kind: 'step', step: { n: 1, text: 'Loading items', status: 'waiting' } });
  });
  it('coalesces real pointer movement, pulses once per press and cancels queued feedback on clear/disposal', () => {
    jest.useFakeTimers();
    const changed = jest.fn(), presentation = new BrowserAgentPresentation(changed);
    for (let x = 1; x <= 100; x++) presentation.input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 20 });
    expect(changed).not.toHaveBeenCalled();
    jest.advanceTimersByTime(32);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(presentation.cursor).toEqual({ x: 100, y: 20, pulse: 0 });
    presentation.input('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 20 });
    expect(presentation.cursor?.pulse).toBe(1);
    presentation.input('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 20 });
    presentation.clear();
    jest.runOnlyPendingTimers();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(presentation.cursor).toBeUndefined();
    presentation.input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
    presentation.dispose(); jest.runOnlyPendingTimers();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(() => presentation.update({ kind: 'step', step: { n: 1, text: 'Late' } })).toThrow('closed');
  });
  it('clears pointer decoration on completion/error while retaining the honest final step', () => {
    const presentation = new BrowserAgentPresentation(() => undefined);
    presentation.update({ kind: 'cursor', point: { x: 20, y: 30 }, highlight: { x: 10, y: 10, width: 40, height: 40 }, pulse: true });
    expect(presentation.cursor?.pulse).toBe(1);
    presentation.update({ kind: 'step', step: { n: 2, total: 2, text: 'Verified', status: 'done' } });
    expect(presentation.cursor).toBeUndefined(); expect(presentation.highlight).toBeUndefined();
    expect(presentation.step?.status).toBe('done');
    presentation.clear(); expect(presentation.step).toBeUndefined(); presentation.dispose();
  });
  it('marks unfinished work interrupted on worker cleanup without replacing a verified outcome', () => {
    const presentation = new BrowserAgentPresentation(() => undefined);
    presentation.update({ kind: 'step', step: { n: 2, total: 3, text: 'Saving', status: 'waiting' } });
    presentation.update({ kind: 'cursor', point: { x: 10, y: 20 } });
    presentation.interrupt();
    expect(presentation.step?.status).toBe('error'); expect(presentation.cursor).toBeUndefined();
    presentation.update({ kind: 'step', step: { n: 3, total: 3, text: 'Saved and verified', status: 'done' } });
    presentation.interrupt(); expect(presentation.step?.text).toBe('Saved and verified'); presentation.dispose();
  });
});
