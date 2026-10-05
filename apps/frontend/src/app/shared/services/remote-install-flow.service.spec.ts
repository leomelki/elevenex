import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteInstallFlowService } from './remote-install-flow.service';

describe('RemoteInstallFlowService', () => {
  const listeners: Array<(event: any) => void> = [];
  const remoteServerApi = {
    ensureReady: vi.fn(),
    recheck: vi.fn(),
    sendInput: vi.fn(() => Promise.resolve(true)),
    resize: vi.fn(() => Promise.resolve(true)),
    closeSession: vi.fn(() => Promise.resolve(true)),
    onInstallerEvent: vi.fn((callback: (event: any) => void) => {
      listeners.push(callback);
      return () => {};
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listeners.length = 0;
    const globalWindow = globalThis as typeof globalThis & { window?: any };
    globalWindow.window = globalWindow.window ?? {};
    globalWindow.window.__ELEVENEX_ELECTRON__ = {
      remoteServer: remoteServerApi as any,
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [RemoteInstallFlowService],
    });
  });

  it('keeps interactive state open until a successful recheck resolves the pending flow', async () => {
    remoteServerApi.ensureReady.mockResolvedValue({
      status: 'waiting-for-user',
      installPhase: 'missing-prereqs',
      installStatus: 'missing-prereqs',
      remotePlatform: 'linux',
      remoteArch: 'x64',
      missingDependencies: ['tmux'],
      message: 'Install tmux first.',
      localPort: null,
      sessionId: 77,
      osRelease: { ID: 'ubuntu' },
      installGuidance: [{ dependency: 'tmux', commands: ['sudo apt install -y tmux'] }],
      version: 'abc123',
    });
    remoteServerApi.recheck.mockResolvedValue({
      status: 'ready',
      installPhase: 'ready',
      installStatus: 'available',
      remotePlatform: 'linux',
      remoteArch: 'x64',
      missingDependencies: [],
      message: '',
      localPort: 4310,
      sessionId: null,
      osRelease: { ID: 'ubuntu' },
      installGuidance: [],
      version: 'abc123',
    });

    const service = TestBed.inject(RemoteInstallFlowService);
    const pending = service.ensureReady({
      id: 19,
      sshHost: 'example.com',
      sshPort: 22,
      bindAddress: '127.0.0.1',
      localPort: 4310,
      remoteHost: '127.0.0.1',
      remotePort: 11111,
    });

    await vi.waitFor(() => expect(service.state()?.sessionId).toBe(77));

    listeners[0]?.({ sessionId: 77, type: 'data', data: 'sudo apt install -y tmux\r\n' });
    expect(service.state()?.terminalOutput.join('')).toContain('sudo apt install -y tmux');

    await service.recheck();
    const result = await pending;

    expect(result.status).toBe('ready');
    expect(result.localPort).toBe(4310);
    expect(service.state()).toBeNull();
  });

  it('closes the active installer session when a later ensure-ready call resolves the flow', async () => {
    remoteServerApi.ensureReady
      .mockResolvedValueOnce({
        status: 'waiting-for-user',
        installPhase: 'missing-prereqs',
        installStatus: 'missing-prereqs',
        remotePlatform: 'linux',
        remoteArch: 'x64',
        missingDependencies: ['tmux'],
        message: 'Install tmux first.',
        localPort: null,
        sessionId: 77,
        osRelease: { ID: 'ubuntu' },
        installGuidance: [{ dependency: 'tmux', commands: ['sudo apt install -y tmux'] }],
        version: 'abc123',
      })
      .mockResolvedValueOnce({
        status: 'ready',
        installPhase: 'ready',
        installStatus: 'available',
        remotePlatform: 'linux',
        remoteArch: 'x64',
        missingDependencies: [],
        message: '',
        localPort: 4310,
        sessionId: null,
        osRelease: { ID: 'ubuntu' },
        installGuidance: [],
        version: 'abc123',
      });

    const service = TestBed.inject(RemoteInstallFlowService);
    const pending = service.ensureReady({
      id: 19,
      sshHost: 'example.com',
      sshPort: 22,
      bindAddress: '127.0.0.1',
      localPort: 4310,
      remoteHost: '127.0.0.1',
      remotePort: 11111,
    });

    await vi.waitFor(() => expect(service.state()?.sessionId).toBe(77));

    const result = await service.ensureReady({
      id: 19,
      sshHost: 'example.com',
      sshPort: 22,
      bindAddress: '127.0.0.1',
      localPort: 4310,
      remoteHost: '127.0.0.1',
      remotePort: 11111,
    });

    expect(result.status).toBe('ready');
    expect(await pending).toEqual(result);
    expect(service.state()).toBeNull();
    expect(remoteServerApi.closeSession).toHaveBeenCalledWith(77);
  });
  it('does not open an installer from a result arriving after cancellation', async () => {
    let finish!: (value: unknown) => void;
    remoteServerApi.ensureReady.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const service = TestBed.inject(RemoteInstallFlowService);
    const pending = service.ensureReady({ id: 19, sshHost: 'example.com' } as any, controller.signal);
    controller.abort(new Error('Canceled'));
    await expect(pending).rejects.toThrow('Canceled');
    finish({ status: 'waiting-for-user', sessionId: 77 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.state()).toBeNull();
  });

  it('clears installer UI immediately even if closing its SSH terminal hangs', async () => {
    remoteServerApi.ensureReady.mockResolvedValue({ status: 'waiting-for-user', sessionId: 77 });
    remoteServerApi.closeSession.mockReturnValueOnce(new Promise(() => {}));
    const service = TestBed.inject(RemoteInstallFlowService);
    const pending = service.ensureReady({ id: 19, sshHost: 'example.com' } as any);
    await vi.waitFor(() => expect(service.state()?.sessionId).toBe(77));
    void service.cancel();
    expect(service.state()).toBeNull();
    expect((await pending).status).toBe('error');
  });

  it('makes a failed recheck actionable rather than leaving checking enabled forever', async () => {
    remoteServerApi.ensureReady.mockResolvedValue({ status: 'waiting-for-user', sessionId: 77 });
    remoteServerApi.recheck.mockRejectedValue(new Error('Network lost'));
    const service = TestBed.inject(RemoteInstallFlowService);
    const pending = service.ensureReady({ id: 19, sshHost: 'example.com' } as any);
    await vi.waitFor(() => expect(service.state()?.sessionId).toBe(77));
    await service.recheck();
    expect(service.state()?.checking).toBe(false);
    expect(service.state()?.terminalError).toBe('Network lost');
    await service.cancel();
    await pending;
  });

});
