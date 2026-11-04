import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { BackendResult, TaskBrowserState, ElevenexBridge } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { TaskBrowserStore } from './task-browser.store';
function state(scopeId: string, taskId: number, revision = 0): TaskBrowserState {
  return { scopeId, taskId, revision, surfaceEpoch: 0, controlsFocus: 0, active: null, tabs: [], picked: null, picking: false, pickerMessage: null, feedback: false, ports: [], privacy: 'content-withheld' };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function setup() {
  let listener!: (state: TaskBrowserState) => void;
  const stop = vi.fn(), read = deferred<BackendResult<TaskBrowserState>>();
  const bridge = {
    onTaskBrowserChanged: vi.fn(callback => { listener = callback; return stop; }),
    taskBrowserRead: vi.fn(() => read.promise),
    taskBrowserCommand: vi.fn(async () => ({ ok: true, value: state('scope', 1, 4) }) as const),
    taskBrowserHide: vi.fn(async () => undefined),
  } satisfies Pick<ElevenexBridge, 'onTaskBrowserChanged' | 'taskBrowserRead' | 'taskBrowserCommand' | 'taskBrowserHide'>;
  TestBed.configureTestingModule({ providers: [TaskBrowserStore, { provide: ELEVENEX_BRIDGE, useValue: bridge }] });
  const store = TestBed.inject(TaskBrowserStore);
  return { store, bridge, read, stop, emit: (value: TaskBrowserState) => listener(value) };
}
afterEach(() => TestBed.resetTestingModule());
describe('Task browser ownership', () => {
  it('subscribes before reads, retains task state across same-task conversations, and rejects old revisions', async () => {
    const { store, bridge, read, emit } = setup();
    store.open('scope', 1); emit(state('scope', 1, 3));
    read.resolve({ ok: true, value: state('scope', 1, 1) }); await read.promise; await Promise.resolve();
    expect(store.state()?.revision).toBe(3);
    store.open('scope', 1); expect(bridge.taskBrowserRead).toHaveBeenCalledTimes(1);
    emit(state('scope', 2, 50)); emit(state('old-scope', 1, 50)); expect(store.state()?.revision).toBe(3);
  });
  it('discards late task/scope replies, hides immediately and owns subscription cleanup', async () => {
    const { store, bridge, read, emit, stop } = setup();
    store.open('scope', 1); store.open('next', 2);
    read.resolve({ ok: true, value: state('scope', 1, 100) }); await read.promise; await Promise.resolve();
    expect(store.state()).toBeNull();
    emit(state('next', 2, 1)); expect(store.state()?.taskId).toBe(2);
    expect(bridge.taskBrowserHide).toHaveBeenCalled();
    TestBed.resetTestingModule(); expect(stop).toHaveBeenCalledTimes(1);
    emit(state('next', 2, 9)); expect(store.state()?.revision).toBe(1);
    await store.command({ kind: 'open', url: 'https://example.com' }); expect(bridge.taskBrowserCommand).not.toHaveBeenCalled();
  });
  it('never applies an interrupted mutation to a newly selected conversation task', async () => {
    const { store, bridge, read, emit } = setup();
    store.open('scope', 1); read.resolve({ ok: true, value: state('scope', 1, 1) }); await read.promise;
    const command = store.command({ kind: 'handoff', tabId: 'tab', sessionId: 2 });
    store.open('scope', 3); emit(state('scope', 3, 2)); await command;
    expect(bridge.taskBrowserCommand).toHaveBeenCalledWith('scope', 1, { kind: 'handoff', tabId: 'tab', sessionId: 2 });
    expect(store.state()?.taskId).toBe(3);
  });
});

describe('Browser placement changes', () => {
  it('accepts a replacement engine revision domain and rejects a late replacement after task navigation', async () => {
    const read = deferred<BackendResult<TaskBrowserState>>(), replacement = deferred<BackendResult<TaskBrowserState>>();
    const bridge = {
      taskBrowserRead: vi.fn(() => read.promise),
      taskBrowserConfigure: vi.fn(() => replacement.promise),
      taskBrowserHide: vi.fn(async () => undefined),
    };
    TestBed.configureTestingModule({ providers: [TaskBrowserStore, { provide: ELEVENEX_BRIDGE, useValue: bridge }] });
    const store = TestBed.inject(TaskBrowserStore);
    store.open('scope', 1); read.resolve({ ok: true, value: state('scope', 1, 100) }); await read.promise; await Promise.resolve();
    const change = store.configure('machine');
    replacement.resolve({ ok: true, value: { ...state('scope', 1, 0), placement: 'machine' } }); await change;
    expect(store.state()?.revision).toBe(0); expect(store.state()?.placement).toBe('machine');
    const late = deferred<BackendResult<TaskBrowserState>>(); bridge.taskBrowserConfigure.mockReturnValueOnce(late.promise);
    const changedAgain = store.configure('desktop-proxy');
    store.open('other-scope', 2);
    late.resolve({ ok: true, value: state('scope', 1, 200) }); await changedAgain;
    expect(store.state()?.scopeId).not.toBe('scope');
  });
});
