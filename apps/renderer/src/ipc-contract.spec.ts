import { describe, expectTypeOf, it } from 'vitest';
import type { BackendStatus, ElevenexBridge, EnvironmentSnapshot, RemoteHost, GitStatus, Invoke, Subscribe, Theme } from '@elevenex/shared';

describe('IPC bridge contract', () => {
  it('keeps the public API arguments and replies typed', () => {
    expectTypeOf<Parameters<ElevenexBridge['gitStatus']>>().toEqualTypeOf<[path: string]>();
    expectTypeOf<ReturnType<ElevenexBridge['gitStatus']>>().toEqualTypeOf<Promise<GitStatus>>();
    expectTypeOf<ReturnType<ElevenexBridge['appVersion']>>().toEqualTypeOf<Promise<string>>();
    expectTypeOf<Parameters<Parameters<ElevenexBridge['onThemeChanged']>[0]>>().toEqualTypeOf<[theme: Theme]>();
    expectTypeOf<ReturnType<ElevenexBridge['onThemeChanged']>>().toEqualTypeOf<() => void>();
    expectTypeOf<Window['elevenex']>().toEqualTypeOf<ElevenexBridge>();
    expectTypeOf<ReturnType<ElevenexBridge['backendStatus']>>().toEqualTypeOf<Promise<BackendStatus>>();
    expectTypeOf<ReturnType<ElevenexBridge['retryBackend']>>().toEqualTypeOf<Promise<BackendStatus>>();
    expectTypeOf<ReturnType<ElevenexBridge['restartBackend']>>().toEqualTypeOf<Promise<BackendStatus>>();
    expectTypeOf<Parameters<Parameters<ElevenexBridge['onBackendChanged']>[0]>>().toEqualTypeOf<[status: BackendStatus]>();
    expectTypeOf<ReturnType<ElevenexBridge['onBackendChanged']>>().toEqualTypeOf<() => void>();
    expectTypeOf<ReturnType<ElevenexBridge['remoteHosts']>>().toEqualTypeOf<Promise<readonly RemoteHost[]>>();
    expectTypeOf<ReturnType<ElevenexBridge['environmentStatus']>>().toEqualTypeOf<Promise<EnvironmentSnapshot>>();
    expectTypeOf<ReturnType<ElevenexBridge['onEnvironmentChanged']>>().toEqualTypeOf<() => void>();
  });
});

// These negative assertions are checked by tsc in pnpm test. Vitest alone only
// transpiles tests, which would silently miss an accidentally weakened contract.
function checkContract(invoke: Invoke, subscribe: Subscribe): void {
  expectTypeOf(invoke('git:status', '/workspace')).toEqualTypeOf<Promise<GitStatus>>();
  expectTypeOf(invoke('app:version')).toEqualTypeOf<Promise<string>>();
  expectTypeOf(invoke('backend:status')).toEqualTypeOf<Promise<BackendStatus>>();
  expectTypeOf(invoke('environment:select', { kind: 'remote', hostId: 'host-id' })).toEqualTypeOf<Promise<EnvironmentSnapshot>>();
  // @ts-expect-error Draft updates must name the environment they belong to.
  void invoke('environment:context', { projectId: null, taskId: null, sessionId: null, draft: '', cursor: null });
  // @ts-expect-error Window ownership comes from the sender, never a renderer id.
  void invoke('remote:disconnect', 42);
  // @ts-expect-error Trust replies do not accept arbitrary Electron objects.
  void invoke('remote:answer', 'challenge-id', { sender: 'other-window' });
  // @ts-expect-error Hosts have no saved credential field.
  void invoke('remote:save-host', { name: 'dev', host: 'dev', forwardAgent: false, password: 'secret' }, null);
  // @ts-expect-error Forwarded services cannot select a public bind address.
  void invoke('remote:add-forward', { remotePort: 8000, localPort: 0, label: 'web', bind: '0.0.0.0' });
  // @ts-expect-error A renderer cannot choose a runtime URL or executable.
  void invoke('backend:retry', 'https://untrusted.test/backend');
  // @ts-expect-error Backend snapshots are serializable domain data.
  subscribe('backend:changed', (event: { sender: unknown }) => void event);
  // @ts-expect-error Unknown channels cannot cross the bridge.
  void invoke('git:delete', '/workspace');
  // @ts-expect-error git:status requires its path argument.
  void invoke('git:status');
  // @ts-expect-error A path must be a string.
  void invoke('git:status', 123);
  // @ts-expect-error app:version accepts no arguments.
  void invoke('app:version', 'extra');
  // @ts-expect-error Events have their own typed allowlist.
  subscribe('theme:other', () => undefined);
  // @ts-expect-error The event payload is a theme, never an Electron event.
  subscribe('theme:changed', (event: { sender: unknown }) => void event);
}
void checkContract;
