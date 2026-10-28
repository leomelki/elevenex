import { describe, expectTypeOf, it } from 'vitest';
import type { BackendStatus, ElevenexBridge, EnvironmentSnapshot, RemoteHost, GitStatus, Invoke, Subscribe, Theme } from '@elevenex/shared';
import type { BackendClientState, BackendInfo, BackendResult, MachineState } from '@elevenex/shared';

describe('IPC bridge contract', () => {
  it('keeps the public API arguments and replies typed', () => {
    expectTypeOf<Parameters<ElevenexBridge['gitStatus']>>().toEqualTypeOf<[path: string]>();
    expectTypeOf<ReturnType<ElevenexBridge['gitStatus']>>().toEqualTypeOf<Promise<GitStatus>>();
    expectTypeOf<ReturnType<ElevenexBridge['appVersion']>>().toEqualTypeOf<Promise<string>>();
    expectTypeOf<Parameters<Parameters<ElevenexBridge['onThemeChanged']>[0]>>().toEqualTypeOf<[theme: Theme]>();
    expectTypeOf<ReturnType<ElevenexBridge['onThemeChanged']>>().toEqualTypeOf<() => void>();
    expectTypeOf<Window['elevenex']>().toEqualTypeOf<ElevenexBridge>();
    expectTypeOf<Parameters<ElevenexBridge['workspaceProjectNameAvailability']>>().toEqualTypeOf<[scopeId: string, name: string]>();
    expectTypeOf<ReturnType<ElevenexBridge['workspaceProjectNameAvailability']>>().toEqualTypeOf<Promise<BackendResult<{ readonly available: boolean }>>>();
    expectTypeOf<ReturnType<ElevenexBridge['backendStatus']>>().toEqualTypeOf<Promise<BackendStatus>>();
    expectTypeOf<ReturnType<ElevenexBridge['retryBackend']>>().toEqualTypeOf<Promise<BackendStatus>>();
    expectTypeOf<ReturnType<ElevenexBridge['restartBackend']>>().toEqualTypeOf<Promise<BackendStatus>>();
    expectTypeOf<Parameters<Parameters<ElevenexBridge['onBackendChanged']>[0]>>().toEqualTypeOf<[status: BackendStatus]>();
    expectTypeOf<ReturnType<ElevenexBridge['onBackendChanged']>>().toEqualTypeOf<() => void>();
    expectTypeOf<ReturnType<ElevenexBridge['remoteHosts']>>().toEqualTypeOf<Promise<readonly RemoteHost[]>>();
    expectTypeOf<ReturnType<ElevenexBridge['environmentStatus']>>().toEqualTypeOf<Promise<EnvironmentSnapshot>>();
    expectTypeOf<ReturnType<ElevenexBridge['onEnvironmentChanged']>>().toEqualTypeOf<() => void>();
    expectTypeOf<ReturnType<ElevenexBridge['backendClientState']>>().toEqualTypeOf<Promise<BackendClientState>>();
    expectTypeOf<Parameters<ElevenexBridge['backendInfo']>>().toEqualTypeOf<[scopeId: string]>();
    expectTypeOf<ReturnType<ElevenexBridge['backendInfo']>>().toEqualTypeOf<Promise<BackendResult<BackendInfo>>>();
    expectTypeOf<ReturnType<ElevenexBridge['onBackendClientChanged']>>().toEqualTypeOf<() => void>();
    expectTypeOf<ReturnType<ElevenexBridge['machineState']>>().toEqualTypeOf<Promise<MachineState>>();
    expectTypeOf<ReturnType<ElevenexBridge['onMachineStateChanged']>>().toEqualTypeOf<() => void>();
  });
});

// These negative assertions are checked by tsc in pnpm test. Vitest alone only
// transpiles tests, which would silently miss an accidentally weakened contract.
function checkContract(invoke: Invoke, subscribe: Subscribe): void {
  // @ts-expect-error Name checks must identify the expected backend scope.
  void invoke('workspace:project-name-availability', 'Project');
  // @ts-expect-error First-run completion requires an expected selected machine.
  void invoke('machines:opened');
  // @ts-expect-error New windows never accept endpoints, commands or credentials.
  void invoke('machines:new-window', { url: 'http://evil', password: 'secret' });
  // @ts-expect-error Suggestions use the main-owned SSH config, never an arbitrary path.
  void invoke('machines:ssh-hosts', 'dev', '/other/file');
  // @ts-expect-error Machine colors must be one of the supplied token names.
  void invoke('machines:edit', { kind: 'local' }, { name: 'My Mac', hue: 'pink' });
  // @ts-expect-error Removal requires an explicit occupied-window confirmation flag.
  void invoke('machines:remove', 'dev');
  // @ts-expect-error Undo accepts only a main-owned token, never a host or file path.
  void invoke('machines:undo-remove', { host: 'dev', identityFile: '/arbitrary/key' });
  expectTypeOf(invoke('git:status', '/workspace')).toEqualTypeOf<Promise<GitStatus>>();
  expectTypeOf(invoke('app:version')).toEqualTypeOf<Promise<string>>();
  expectTypeOf(invoke('backend:status')).toEqualTypeOf<Promise<BackendStatus>>();
  expectTypeOf(invoke('backend-client:info', 'scope-id')).toEqualTypeOf<Promise<BackendResult<BackendInfo>>>();
  // @ts-expect-error Workspace reads require the scope that supplied the selected resource.
  void invoke('workspace:tasks', { projectId: 1 });
  // @ts-expect-error Resource mutations cannot choose endpoints or HTTP methods.
  void invoke('workspace:create-task', 'scope', { repoId: 1, name: 'Task', requestId: 'create', url: 'http://evil' });
  void invoke('workspace:retry-task', 'scope', 1);
  void invoke('workspace:retry-task', 'scope', 1, 'use-existing');
  void invoke('workspace:retry-task', 'scope', 1, 'snapshot');
  void invoke('workspace:retry-task', 'scope', 1, 'exceed-worktree-limit');
  // @ts-expect-error Recovery is a named domain choice, never an arbitrary setup patch.
  void invoke('workspace:retry-task', 'scope', 1, { confirmExternal: true });
  // @ts-expect-error Recovery cannot choose a path or executable.
  void invoke('workspace:retry-task', 'scope', 1, 'arbitrary');
  // @ts-expect-error Stages use the supported domain vocabulary.
  void invoke('workspace:set-stage', 'scope', { taskId: 1, stage: 'unknown' });
  // @ts-expect-error Backend reads require an explicit current window scope.
  void invoke('backend-client:info');
  void invoke('workspace:archive-session', 'scope', {taskId:1,sessionId:2,confirmStop:false});
  void invoke('workspace:restore-session', 'scope', {taskId:1,sessionId:2});
  // @ts-expect-error Session archive must carry an explicit stop confirmation.
  void invoke('workspace:archive-session', 'scope', {taskId:1,sessionId:2});
  // @ts-expect-error Session restoration is scoped to its owning task.
  void invoke('workspace:restore-session', 'scope', {sessionId:2});
  // @ts-expect-error Endpoints, headers and methods cannot be chosen by the renderer.
  void invoke('backend-client:info', { url: 'http://evil', headers: {} });
  // @ts-expect-error The public bridge has no generic HTTP operation.
  void ({} as ElevenexBridge).request('/api/projects');
  expectTypeOf(invoke('environment:select', { kind: 'remote', hostId: 'host-id' })).toEqualTypeOf<Promise<EnvironmentSnapshot>>();
  // @ts-expect-error Draft updates must name the environment they belong to.
  void invoke('environment:context', { projectId: null, taskId: null, sessionId: null, draft: '', cursor: null });
  // @ts-expect-error Window ownership comes from the sender, never a renderer id.
  void invoke('remote:disconnect', 42);
  // @ts-expect-error Trust replies do not accept arbitrary Electron objects.
  void invoke('remote:answer', 'challenge-id', { sender: 'other-window' });
  // @ts-expect-error Hosts have no saved credential field.
  void invoke('remote:save-host', { name: 'dev', host: 'dev', password: 'secret' }, null);
  // @ts-expect-error Agent forwarding belongs to SSH config, not an app override.
  void invoke('remote:save-host', { name: 'dev', host: 'dev', forwardAgent: true }, null);
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
