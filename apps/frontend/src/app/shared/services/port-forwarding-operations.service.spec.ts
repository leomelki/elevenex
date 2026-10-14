import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortForwardingOperationsService } from './port-forwarding-operations.service';
import { SshForwardsService } from './ssh-forwards.service';
import {
  OnboardingStateService,
  readOnboardingStateSnapshot,
  writeOnboardingStateSnapshot,
} from './onboarding-state.service';
import type { PortForwardRequest } from '../models/port-forwarding.model';
import { toast } from 'ngx-sonner';

vi.mock('ngx-sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

describe('PortForwardingOperationsService', () => {
  const forward = {
    id: 12,
    projectId: 5,
    name: 'Preview',
    bindAddress: '127.0.0.1',
    localPort: 5173,
    remoteHost: 'localhost',
    remotePort: 5173,
    status: 'active',
    running: true,
    connectionLabel: 'Studio',
    pairedDeviceId: 3,
    lastError: null,
    debugDetails: { secret: 'must-not-leak' },
  };
  const originalBridge = window.__ELEVENEX_ELECTRON__;
  let service: PortForwardingOperationsService;
  let forwards: {
    isSupported: ReturnType<typeof vi.fn>;
    ensure: ReturnType<typeof vi.fn>;
    getPageByProject: ReturnType<typeof vi.fn>;
    findByProject: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  const request = (
    operation: PortForwardRequest['operation'],
    args: Partial<PortForwardRequest['args']> = {},
  ): PortForwardRequest => ({
    type: 'request',
    id: 'r1',
    operation,
    args: { projectId: 5, ...args },
  });
  const execute = (
    op: PortForwardRequest['operation'],
    args: Partial<PortForwardRequest['args']> = {},
    signal = new AbortController().signal,
  ) => service.execute(request(op, args), signal);
  function selectPaired() {
    writeOnboardingStateSnapshot({
      ...readOnboardingStateSnapshot(),
      mode: 'paired',
      paired: { id: 3, name: 'Studio', localPort: 51234 },
      remoteConnectionReady: true,
    });
  }
  beforeEach(() => {
    localStorage.clear();
    selectPaired();
    forwards = {
      isSupported: vi.fn().mockResolvedValue(true),
      ensure: vi.fn().mockResolvedValue({ forward, reused: false }),
      getPageByProject: vi
        .fn()
        .mockResolvedValue({ forwards: [forward], total: 1, nextOffset: null }),
      findByProject: vi.fn().mockResolvedValue(forward),
      start: vi.fn(() => of(forward)),
      stop: vi.fn(() => of({ ...forward, status: 'inactive', running: false })),
      remove: vi.fn(() => of({ ...forward, status: 'inactive', running: false })),
    };
    TestBed.configureTestingModule({
      providers: [
        PortForwardingOperationsService,
        OnboardingStateService,
        { provide: SshForwardsService, useValue: forwards },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
      ],
    });
    service = TestBed.inject(PortForwardingOperationsService);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    window.__ELEVENEX_ELECTRON__ = originalBridge;
  });

  it('defaults paired creation to loopback, the same port and current connection', async () => {
    const result = await execute('create', { remotePort: 5173 });
    expect(forwards.ensure).toHaveBeenCalledWith(
      5,
      {
        name: 'Port 5173',
        sshHost: '',
        sshUser: undefined,
        sshPort: 22,
        bindAddress: '127.0.0.1',
        localPort: 5173,
        remoteHost: 'localhost',
        remotePort: 5173,
        startImmediately: true,
      },
      expect.any(AbortSignal),
      undefined,
    );
    expect(result.forwards[0]).toMatchObject({
      transport: 'paired',
      localUrl: 'http://127.0.0.1:5173',
      running: true,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });
  it('inherits the current SSH host and user while keeping overrides independent', async () => {
    const server = {
      id: 7,
      name: 'Dev',
      sshHost: 'devhost',
      sshUser: 'alice',
      sshPort: 2222,
      localPort: 51234,
      remotePort: 11111,
      authMode: 'agent',
      identityFilePath: null,
      installStatus: 'available',
      createdAt: '',
      updatedAt: '',
      lastConnectedAt: '',
    };
    writeOnboardingStateSnapshot({
      ...readOnboardingStateSnapshot(),
      mode: 'ssh',
      activeServerId: 7,
      servers: [server as never],
    });
    await execute('create', { remotePort: 3000, localPort: 3001 });
    expect(forwards.ensure.mock.calls[0][1]).toMatchObject({
      sshHost: 'devhost',
      sshUser: 'alice',
      sshPort: 2222,
      localPort: 3001,
    });
    await execute('create', { remotePort: 3000, sshHost: 'other' });
    expect(forwards.ensure.mock.calls[1][1]).toMatchObject({
      sshHost: 'other',
      sshUser: undefined,
      sshPort: 22,
    });
  });

  it('keeps agent creation attribution and reports runtime failures with an error notification', async () => {
    vi.clearAllMocks();
    const creator = { sessionId: 42, sessionName: 'Preview agent' };
    forwards.ensure.mockResolvedValue({
      forward: {
        ...forward,
        status: 'error',
        running: false,
        lastError: 'Local port is occupied',
        createdBySession: creator,
      },
      reused: false,
    });
    const result = await execute('create', { remotePort: 5173, requestedBy: creator });
    expect(forwards.ensure.mock.calls[0][3]).toEqual(creator);
    expect(result.forwards[0].createdBySession).toEqual(creator);
    expect(toast.error).toHaveBeenCalledWith(
      'Could not start port forward: Preview',
      expect.objectContaining({ description: 'Local port is occupied' }),
    );
    expect(toast.info).not.toHaveBeenCalled();
  });
  it('explains when local forwarding needs an explicit SSH host', async () => {
    writeOnboardingStateSnapshot({ ...readOnboardingStateSnapshot(), mode: 'local' });
    await expect(execute('create', { remotePort: 5173 })).rejects.toThrow('Supply sshHost');
    expect(forwards.ensure).not.toHaveBeenCalled();
  });
  it('rejects SSH overrides on paired connections', async () => {
    await expect(execute('create', { remotePort: 5173, sshHost: 'other' })).rejects.toThrow(
      'Omit SSH overrides',
    );
  });
  it('pages only the requested definitions instead of querying every runtime', async () => {
    await execute('list', { limit: 10, offset: 20 });
    expect(forwards.getPageByProject).toHaveBeenCalledWith(5, 10, 20);
  });
  it('never controls a definition outside the requested project and removal is repeatable', async () => {
    forwards.findByProject.mockResolvedValue(null);
    await expect(execute('stop', { forwardId: 12 })).rejects.toThrow('not found in project 5');
    expect(forwards.stop).not.toHaveBeenCalled();
    expect(await execute('remove', { forwardId: 12 })).toMatchObject({
      removed: true,
      forwards: [],
    });
    expect(forwards.remove).not.toHaveBeenCalled();
  });
  it('guards an environment change while waiting for runtime capability', async () => {
    forwards.isSupported.mockImplementation(async () => {
      writeOnboardingStateSnapshot({ ...readOnboardingStateSnapshot(), mode: 'local' });
      return true;
    });
    await expect(execute('create', { remotePort: 5173 })).rejects.toThrow(
      'switched or disconnected',
    );
    expect(forwards.ensure).not.toHaveBeenCalled();
  });
  it('checks cancellation after a read before stopping a listener', async () => {
    const controller = new AbortController();
    forwards.findByProject.mockImplementation(async () => {
      controller.abort();
      return forward;
    });
    await expect(execute('stop', { forwardId: 12 }, controller.signal)).rejects.toThrow();
    expect(forwards.stop).not.toHaveBeenCalled();
  });
});
