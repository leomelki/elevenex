import { AgentFocusService } from './agent-focus.service.js';

describe('AgentFocusService', () => {
  it('records and returns the focused session for a mission', () => {
    const svc = new AgentFocusService();
    svc.record(1, 42);
    const rec = svc.get(1);
    expect(rec?.focusedSessionId).toBe(42);
    expect(typeof rec?.reportedAt).toBe('string');
  });

  it('overwrites focus on each record (latest message wins)', () => {
    const svc = new AgentFocusService();
    svc.record(1, 42);
    svc.record(1, 99);
    expect(svc.get(1)?.focusedSessionId).toBe(99);
  });

  it('clears focus when given null/undefined/invalid id (no open tab)', () => {
    const svc = new AgentFocusService();
    svc.record(1, 42);
    svc.record(1, null);
    expect(svc.get(1)).toBeNull();

    svc.record(1, 42);
    svc.record(1, undefined);
    expect(svc.get(1)).toBeNull();

    svc.record(1, 42);
    svc.record(1, 0);
    expect(svc.get(1)).toBeNull();
  });

  it('keeps focus independent per mission', () => {
    const svc = new AgentFocusService();
    svc.record(1, 10);
    svc.record(2, 20);
    expect(svc.get(1)?.focusedSessionId).toBe(10);
    expect(svc.get(2)?.focusedSessionId).toBe(20);
  });

  it('returns null for an unknown mission', () => {
    expect(new AgentFocusService().get(123)).toBeNull();
  });

  it('clear() drops a mission focus', () => {
    const svc = new AgentFocusService();
    svc.record(1, 42);
    svc.clear(1);
    expect(svc.get(1)).toBeNull();
  });
});
