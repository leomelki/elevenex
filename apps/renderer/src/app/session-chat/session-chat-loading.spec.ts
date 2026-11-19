import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackendClientState } from '@elevenex/shared';
import { BackendClientService } from '../backend/backend-client.service';
import { SessionChatLoadingPolicy, SESSION_CHAT_PROGRESSIVE_LOADING } from './session-chat-loading';

function setup(enabledByDefault = false) {
  const state = signal<BackendClientState>({ revision: 1, scope: { id: 'connection', environment: { kind: 'local' } } });
  TestBed.configureTestingModule({ providers: [
    { provide: BackendClientService, useValue: { state } },
    { provide: SESSION_CHAT_PROGRESSIVE_LOADING, useValue: enabledByDefault },
  ] });
  return { policy: TestBed.inject(SessionChatLoadingPolicy), state };
}

afterEach(() => TestBed.resetTestingModule());

describe('application conversation loading policy', () => {
  it('retains the fallback for the same connection through ordinary lifecycle updates', () => {
    const { policy, state } = setup();
    expect(policy.progressive()).toBe(false);
    expect(policy.enableProgressive('connection')).toBe(true);
    state.set({ revision: 2, scope: { id: 'connection', environment: { kind: 'local' } } });
    expect(policy.progressive()).toBe(true);
    expect(TestBed.inject(SessionChatLoadingPolicy)).toBe(policy);
  });

  it('resets on reconnect or machine change and rejects signals from the old connection', () => {
    const { policy, state } = setup();
    policy.enableProgressive('connection');
    state.set({ revision: 2, scope: null });
    expect(policy.progressive()).toBe(false);
    expect(policy.enableProgressive('connection')).toBe(false);
    state.set({ revision: 3, scope: { id: 'reconnected', environment: { kind: 'local' } } });
    expect(policy.progressive()).toBe(false);
    expect(policy.enableProgressive('connection')).toBe(false);
    policy.enableProgressive('reconnected');
    expect(policy.progressive()).toBe(true);
    state.set({ revision: 4, scope: { id: 'different-machine', environment: { kind: 'local' } } });
    expect(policy.progressive()).toBe(false);
  });

  it('does not persist the fallback across application restart', () => {
    const { policy } = setup();
    policy.enableProgressive('connection');
    TestBed.resetTestingModule();
    expect(setup().policy.progressive()).toBe(false);
  });

  it('retains an explicit rollout flag override independently of adaptive connection state', () => {
    const { policy, state } = setup(true);
    expect(policy.progressive()).toBe(true);
    state.set({ revision: 2, scope: null });
    expect(policy.progressive()).toBe(true);
  });
});
