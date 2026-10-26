import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { BackendClientState, BackendInfo, BackendResult, ElevenexBridge } from '@elevenex/shared';
import { BackendClientService, ELEVENEX_BRIDGE } from './backend-client.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function ready(revision: number, id = `scope-${revision}`): BackendClientState {
  return { revision, scope: { id, environment: { kind: 'local' } } };
}

function setup() {
  const snapshot = deferred<BackendClientState>();
  const reply = deferred<BackendResult<BackendInfo>>();
  const stop = vi.fn();
  let listener!: (state: BackendClientState) => void;
  // Only the adapter's named operations are needed; no implementation cast.
  const bridge = {
    backendClientState: vi.fn(() => snapshot.promise),
    backendInfo: vi.fn(() => reply.promise),
    onBackendClientChanged: vi.fn((fn: (state: BackendClientState) => void) => { listener = fn; return stop; }),
  } satisfies Pick<ElevenexBridge, 'backendClientState' | 'backendInfo' | 'onBackendClientChanged'>;
  TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: bridge }] });
  const client = TestBed.inject(BackendClientService);
  return { client, bridge, snapshot, reply, stop, emit: (state: BackendClientState) => listener(state) };
}

afterEach(() => TestBed.resetTestingModule());

describe('BackendClientService', () => {
  it('subscribes before snapshot and keeps a newer event when bootstrap replies late', async () => {
    const { client, bridge, snapshot, emit } = setup();
    expect(bridge.onBackendClientChanged.mock.invocationCallOrder[0]).toBeLessThan(bridge.backendClientState.mock.invocationCallOrder[0]!);
    emit(ready(3)); snapshot.resolve(ready(1));
    await snapshot.promise;
    expect(client.state()).toEqual(ready(3));
    emit(ready(2)); expect(client.state()).toEqual(ready(3));
  });

  it('does not dispatch until a scope is ready and preserves the typed result', async () => {
    const { client, bridge, emit, reply } = setup();
    expect((await client.info()).ok).toBe(false);
    expect(bridge.backendInfo).not.toHaveBeenCalled();
    emit(ready(1));
    const pending = client.info();
    expect(bridge.backendInfo).toHaveBeenCalledWith('scope-1');
    const result = { ok: true, value: { backendSha: 'a'.repeat(40) } } as const;
    reply.resolve(result); expect(await pending).toEqual(result);
  });

  it('rejects replies from a previous scope and removes listeners on teardown', async () => {
    const { client, emit, reply, stop, snapshot } = setup();
    emit(ready(1));
    const pending = client.info();
    emit(ready(2));
    reply.resolve({ ok: true, value: { backendSha: 'a'.repeat(40) } });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'stale-scope' } });
    TestBed.resetTestingModule(); expect(stop).toHaveBeenCalledTimes(1);
    emit(ready(4)); snapshot.resolve(ready(5)); await snapshot.promise;
    expect(client.state()).toEqual(ready(2));
    expect((await client.info()).ok).toBe(false);
  });

  it('handles IPC rejection and does not overwrite ready state with a bootstrap error', async () => {
    const { client, emit, snapshot, reply } = setup();
    emit(ready(2)); snapshot.reject(new Error('private IPC error'));
    await Promise.resolve(); expect(client.state()).toEqual(ready(2));
    const pending = client.info(); reply.reject(new Error('private transport error'));
    expect(await pending).toEqual({ ok: false, error: { code: 'transport', message: 'Backend connection failed.' } });
  });

  it('rejects an in-flight reply after the owning Angular application is destroyed', async () => {
    const { client, emit, reply, stop } = setup();
    emit(ready(1));
    const pending = client.info();
    TestBed.resetTestingModule();
    expect(stop).toHaveBeenCalledTimes(1);
    reply.resolve({ ok: true, value: { backendSha: 'a'.repeat(40) } });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'stale-scope' } });
  });
});
