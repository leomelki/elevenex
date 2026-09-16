import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { SshForwardsService } from './ssh-forwards.service';

describe('SshForwardsService', () => {
  const FORWARDS_KEY = 'elevenex-ssh-forwards@local';
  const UPGRADE_KEY = 'elevenex-ssh-forwards-loopback-upgraded@local';

  const makeStored = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    projectId: 5,
    name: 'Vite',
    sshHost: 'workstation',
    sshPort: 22,
    sshUser: 'bits',
    bindAddress: '127.0.0.1',
    localPort: 5178,
    remoteHost: '127.0.0.1',
    remotePort: 5178,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  });

  const readStoredForwards = () => JSON.parse(localStorage.getItem(FORWARDS_KEY) ?? '{}');

  let service: SshForwardsService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SshForwardsService] });
    service = TestBed.inject(SshForwardsService);
  });

  it('rewrites loopback IP literals in stored forwards to localhost', async () => {
    localStorage.setItem(FORWARDS_KEY, JSON.stringify({
      5: [makeStored(), makeStored({ id: 2, remoteHost: '::1' })],
    }));

    const forwards = await service.getAllOnce();

    expect(forwards.map(forward => forward.remoteHost)).toEqual(['localhost', 'localhost']);
    expect(readStoredForwards()[5].map((entry: { remoteHost: string }) => entry.remoteHost))
      .toEqual(['localhost', 'localhost']);
  });

  it('leaves non-loopback remote hosts untouched', async () => {
    localStorage.setItem(FORWARDS_KEY, JSON.stringify({
      5: [makeStored({ remoteHost: '10.0.0.4' })],
    }));

    const forwards = await service.getAllOnce();

    expect(forwards[0].remoteHost).toBe('10.0.0.4');
  });

  it('only rewrites once, so a hand-typed loopback host survives', async () => {
    localStorage.setItem(UPGRADE_KEY, 'done');
    localStorage.setItem(FORWARDS_KEY, JSON.stringify({ 5: [makeStored()] }));

    const forwards = await service.getAllOnce();

    expect(forwards[0].remoteHost).toBe('127.0.0.1');
  });

  it('defaults a created forward to the remote host it was given', async () => {
    const created = await service.create(5, {
      name: 'Vite',
      sshHost: 'workstation',
      sshUser: 'bits',
      sshPort: 22,
      bindAddress: '127.0.0.1',
      localPort: 5178,
      remoteHost: 'localhost',
      remotePort: 5178,
      startImmediately: false,
    }).toPromise();

    expect(created?.remoteHost).toBe('localhost');
    expect(created?.destinationLabel).toBe('127.0.0.1:5178 -> localhost:5178');
  });
});
