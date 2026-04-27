import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from './app';
import { OnboardingStartupService } from './shared/services/onboarding-startup.service';
import { RemoteInstallFlowService } from './shared/services/remote-install-flow.service';
import { SshRuntimeRecoveryService } from './shared/services/ssh-runtime-recovery.service';

describe('App', () => {
  const prompt = signal<any>(null);
  const disconnectedBanner = signal<any>(null);
  const remoteDisconnect = signal<any>(null);
  const remoteRetrying = signal(false);
  const remoteInstallState = signal<any>(null);
  const startupServiceMock = {
    startupPortForwardPrompt: prompt.asReadonly(),
    dismissStartupPortForwardPrompt: vi.fn(),
    startStartupPortForward: vi.fn(() => Promise.resolve()),
    startAllStartupPortForwards: vi.fn(() => Promise.resolve()),
  };
  const runtimeRecoveryServiceMock = {
    disconnectedForwardsBanner: disconnectedBanner.asReadonly(),
    remoteDisconnect: remoteDisconnect.asReadonly(),
    remoteRetrying: remoteRetrying.asReadonly(),
    startMonitoring: vi.fn(() => Promise.resolve()),
    stopMonitoring: vi.fn(),
    dismissDisconnectedForwardsBanner: vi.fn(),
    reconnectAllDisconnectedForwards: vi.fn(() => Promise.resolve([])),
    retryRemoteConnection: vi.fn(() => Promise.resolve()),
  };
  const remoteInstallFlowMock = {
    state: remoteInstallState.asReadonly(),
    recheck: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(() => Promise.resolve()),
    sendInput: vi.fn(() => Promise.resolve()),
    resize: vi.fn(() => Promise.resolve()),
  };
  const windowControlsMock = {
    getEnvironment: vi.fn(() =>
      Promise.resolve({
        isElectron: true,
        platform: 'linux' as const,
        usesNativeMacControls: false,
      }),
    ),
    minimize: vi.fn(() => Promise.resolve()),
    maximize: vi.fn(() =>
      Promise.resolve({
        isMaximized: true,
        isFullScreen: false,
        isFocused: true,
      }),
    ),
    unmaximize: vi.fn(() =>
      Promise.resolve({
        isMaximized: false,
        isFullScreen: false,
        isFocused: true,
      }),
    ),
    toggleMaximize: vi.fn(() =>
      Promise.resolve({
        isMaximized: true,
        isFullScreen: false,
        isFocused: true,
      }),
    ),
    close: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() =>
      Promise.resolve({
        isMaximized: false,
        isFullScreen: false,
        isFocused: true,
      }),
    ),
    onStateChanged: vi.fn(() => () => {}),
  };

  beforeEach(async () => {
    prompt.set(null);
    disconnectedBanner.set(null);
    remoteDisconnect.set(null);
    remoteRetrying.set(false);
    remoteInstallState.set(null);
    vi.clearAllMocks();
    window.__ELEVENEX_ELECTRON__ = undefined;
    window.__ELEVENEX_RUNTIME__ = undefined;

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });

    (globalThis as typeof globalThis & { ResizeObserver?: any }).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    };

    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        { provide: OnboardingStartupService, useValue: startupServiceMock },
        { provide: RemoteInstallFlowService, useValue: remoteInstallFlowMock },
        { provide: SshRuntimeRecoveryService, useValue: runtimeRecoveryServiceMock },
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the app shell', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.app-shell')).toBeTruthy();
  });

  it('should render the startup forward banner when prompt state exists', async () => {
    prompt.set({
      serverLabel: 'deploy@example.com:22',
      totalCount: 1,
      forwards: [
        {
          id: 7,
          projectId: 4,
          name: 'API',
          localPort: 3000,
          remoteHost: '127.0.0.1',
          remotePort: 3000,
          destinationLabel: '127.0.0.1:3000 -> 127.0.0.1:3000',
        },
      ],
      startingIds: [],
    });

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('1 port configured. Start forwarding?');

    const startAllButton = Array.from(compiled.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Start forwarding'));

    startAllButton?.click();
    expect(startupServiceMock.startAllStartupPortForwards).toHaveBeenCalled();
  });

  it('should render the disconnected forward banner when runtime disconnects are present', async () => {
    disconnectedBanner.set({
      totalCount: 2,
      forwards: [
        {
          id: 7,
          projectId: 4,
          name: 'API',
          localPort: 3000,
          remoteHost: '127.0.0.1',
          remotePort: 3000,
          destinationLabel: '127.0.0.1:3000 -> 127.0.0.1:3000',
          lastError: 'Connection reset',
        },
      ],
      reconnectingIds: [],
    });

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('2 ports disconnected. Reconnect?');

    const reconnectButton = Array.from(compiled.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Reconnect'));

    reconnectButton?.click();
    expect(runtimeRecoveryServiceMock.reconnectAllDisconnectedForwards).toHaveBeenCalled();
  });

  it('should make the startup banner draggable and toggle maximize on double click in Electron', async () => {
    window.__ELEVENEX_ELECTRON__ = {
      windowControls: windowControlsMock,
    };

    prompt.set({
      serverLabel: 'deploy@example.com:22',
      totalCount: 1,
      forwards: [],
      startingIds: [],
    });

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const banner = compiled.querySelector('.startup-forward-bar') as HTMLElement | null;
    expect(banner).toBeTruthy();
    expect(banner?.classList.contains('startup-forward-bar--draggable')).toBe(true);

    banner?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await fixture.whenStable();

    expect(windowControlsMock.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it('should render the blocking remote disconnect overlay when the remote tunnel drops', async () => {
    remoteDisconnect.set({
      server: {
        id: 19,
        name: 'Prod',
        sshHost: 'example.com',
        sshUser: 'deploy',
        sshPort: 22,
        authMode: 'agent',
        identityFilePath: null,
        localPort: 4200,
        remotePort: 11111,
        installStatus: 'available',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        lastConnectedAt: '2024-01-01',
      },
      localPort: 4200,
      message: 'Tunnel dropped unexpectedly.',
    });

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.runtime-remote-overlay')).toBeTruthy();
    expect(compiled.textContent).toContain('Reconnect to continue');
    expect(compiled.textContent).toContain('Tunnel dropped unexpectedly.');
  });

  it('should render the shared remote install modal when manual remote setup is required', async () => {
    remoteInstallState.set({
      sessionId: 5,
      payload: {
        id: 19,
        sshHost: 'example.com',
        sshPort: 22,
        bindAddress: '127.0.0.1',
        localPort: 4310,
        remoteHost: '127.0.0.1',
        remotePort: 11111,
      },
      result: {
        status: 'waiting-for-user',
        installPhase: 'missing-prereqs',
        installStatus: 'missing-prereqs',
        remotePlatform: 'linux',
        remoteArch: 'x64',
        missingDependencies: ['tmux'],
        message: 'Install tmux and re-check.',
        localPort: null,
        sessionId: 5,
        osRelease: { ID: 'ubuntu' },
        suggestedCommands: ['sudo apt install -y tmux'],
        version: 'abc123',
      },
      terminalOutput: [],
      terminalExited: false,
      terminalError: null,
      checking: false,
    });

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.remote-install-overlay')).toBeTruthy();
    expect(compiled.textContent).toContain('Finish preparing the remote server');
    expect(compiled.textContent).toContain('sudo apt install -y tmux');
  });
});
