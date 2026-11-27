import { machineReach } from './machine-reach';
import type { RemoteConnectionStatus } from '@elevenex/shared';
const remote: RemoteConnectionStatus = { hostId: 'dev', phase: 'recovering', stage: 'transport', authenticated: false, transport: 'closed', application: 'unavailable', attempt: 2, retryAt: 5000, failure: null, progress: null, generation: 1, instanceId: 'same' };
describe('Outage escalation', () => {
  it('stays quiet briefly, counts down, then explains a long outage', () => {
    expect(machineReach('dev-box', 0, 1000, remote, null)).toBeNull();
    expect(machineReach('dev-box', 0, 2000, remote, null)?.text).toContain('in 3 s');
    expect(machineReach('dev-box', 0, 30000, remote, null)?.text).toContain('Can’t reach dev-box');
    expect(machineReach('dev-box', 0, 600000, { ...remote, retryStoppedAt: 600000 }, null)?.text).toContain('Try again');
  });
  it('prioritizes real challenges and reserves danger for host trust', () => {
    expect(machineReach('dev-box', 0, 3000, remote, { id: 'key', kind: 'credential', prompt: 'Passphrase:', expiresAt: 10000 })).toMatchObject({ fresh: true, tone: 'warn', detail: 'Unlock your key' });
    expect(machineReach('dev-box', 0, 3000, { ...remote, failure: { stage: 'authentication', code: 'host-trust', message: 'Changed', action: 'verify-host', transient: false } }, null)?.tone).toBe('danger');
  });
  it('reports a slow sign-in quietly instead of a network outage', () => {
    const waiting = { ...remote, stage: 'authentication', slowSignIn: true } as const;
    expect(machineReach('dev-box', 0, 1000, waiting, null)).toMatchObject({ key: 'slow-sign-in', text: 'dev-box · still signing in', tone: 'warn', fresh: false });
    expect(machineReach('dev-box', 0, 60000, waiting, null)?.key).toBe('slow-sign-in');
    expect(machineReach('dev-box', 0, 3000, waiting, { id: 'pin', kind: 'credential', prompt: 'Enter PIN:', expiresAt: 10000 })?.key).toBe('needs-credential');
  });
});
