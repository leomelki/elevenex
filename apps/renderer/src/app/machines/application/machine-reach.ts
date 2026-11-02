import type { RemoteChallenge, RemoteConnectionStatus } from '@elevenex/shared';

export interface MachineReach {
  readonly key: string;
  readonly text: string;
  readonly detail: string;
  readonly tone: 'warn' | 'danger';
  readonly fresh: boolean;
}

/** Copy follows elapsed outage time and real SSH recovery capabilities. */
export function machineReach(name: string, since: number, now: number, remote: RemoteConnectionStatus | null, challenge: RemoteChallenge | null, askSince = since): MachineReach | null {
  const elapsed = now - since;
  const safety = remote?.failure?.code === 'host-trust';
  const fresh = now - askSince < 4000;
  if (safety) return { key: 'host-trust', text: `${name}’s identity could not be verified · Check`, detail: 'Nothing was sent. Verify the host fingerprint and repair known_hosts before trying again.', tone: 'danger', fresh };
  if (challenge) {
    const prompt = challenge.prompt;
    const action = challenge.kind === 'notification' ? 'check SSH' : challenge.kind === 'trust' ? 'check the host key' : /passphrase/i.test(prompt) ? 'unlock your key' : /(?:code|otp|verification)/i.test(prompt) ? 'enter a code' : /password/i.test(prompt) ? 'enter your password' : 'answer SSH';
    return { key: 'needs-' + challenge.kind, text: fresh ? `${name} needs you to reconnect` : `${name} · ${action}`, detail: action[0]!.toUpperCase() + action.slice(1), tone: 'warn', fresh };
  }
  if (remote?.phase === 'awaiting-input') return { key: 'other-window', text: `${name} · sign-in open in another window`, detail: 'A window on this machine already has the SSH prompt. Answer there once to reconnect every window.', tone: 'warn', fresh: false };
  if (remote?.retryStoppedAt !== undefined) return { key: 'stopped', text: `Couldn’t reconnect to ${name} · Try again`, detail: 'Timed retries stopped after ten minutes. A network change or waking this computer tries again.', tone: 'warn', fresh: false };
  if (remote?.phase === 'paused') return { key: 'paused', text: `${name} needs you to reconnect · Try again`, detail: remote.failure?.message ?? 'Check the machine, then try again.', tone: 'warn', fresh };
  if (elapsed < 2000) return null;
  if (elapsed >= 30000) return { key: 'long', text: `Can’t reach ${name} · Try now`, detail: 'Your loaded work stays here. Writing waits for the machine.', tone: 'warn', fresh: false };
  const seconds = remote?.retryAt ? Math.max(0, Math.ceil((remote.retryAt - now) / 1000)) : 0;
  return { key: 'retry', text: `${name} · reconnecting${seconds ? ` in ${seconds} s` : '…'}`, detail: 'Trying to reconnect. Your loaded work stays here.', tone: 'warn', fresh: false };
}
