import { describe, expectTypeOf, it } from 'vitest';
import type { ElevenexBridge, GitStatus, Invoke, Subscribe, Theme } from '@elevenex/shared';

describe('IPC bridge contract', () => {
  it('keeps the public API arguments and replies typed', () => {
    expectTypeOf<Parameters<ElevenexBridge['gitStatus']>>().toEqualTypeOf<[path: string]>();
    expectTypeOf<ReturnType<ElevenexBridge['gitStatus']>>().toEqualTypeOf<Promise<GitStatus>>();
    expectTypeOf<ReturnType<ElevenexBridge['appVersion']>>().toEqualTypeOf<Promise<string>>();
    expectTypeOf<Parameters<Parameters<ElevenexBridge['onThemeChanged']>[0]>>().toEqualTypeOf<[theme: Theme]>();
    expectTypeOf<ReturnType<ElevenexBridge['onThemeChanged']>>().toEqualTypeOf<() => void>();
    expectTypeOf<Window['elevenex']>().toEqualTypeOf<ElevenexBridge>();
  });
});

// These negative assertions are checked by tsc in pnpm test. Vitest alone only
// transpiles tests, which would silently miss an accidentally weakened contract.
function checkContract(invoke: Invoke, subscribe: Subscribe): void {
  expectTypeOf(invoke('git:status', '/workspace')).toEqualTypeOf<Promise<GitStatus>>();
  expectTypeOf(invoke('app:version')).toEqualTypeOf<Promise<string>>();
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
