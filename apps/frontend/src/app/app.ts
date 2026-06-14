import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet, RouterLink } from '@angular/router';
import { NgxSonnerToaster } from 'ngx-sonner';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCopy,
  lucideHardDrive,
  lucideLoader,
  lucideMinus,
  lucidePlay,
  lucideRefreshCw,
  lucideSquare,
  lucideTriangleAlert,
  lucideWifiOff,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { Sidebar } from './features/navigation/sidebar/sidebar';
import { EnvironmentSwitcherComponent } from './features/navigation/environment-switcher/environment-switcher.component';
import { RemoteInstallModalComponent } from './features/remote-install/remote-install-modal.component';
import { getRuntimeConfig } from './shared/runtime/runtime-config';
import {
  ElectronWindowState,
  getElectronAppApi,
  getElectronWindowControlsApi,
} from './shared/runtime/electron-window-controls';
import { TmuxRequiredOverlayComponent } from './features/tmux-required/tmux-required-overlay.component';
import { OnboardingStateService } from './shared/services/onboarding-state.service';
import { OnboardingStartupService } from './shared/services/onboarding-startup.service';
import { CONNECTING_PHASES, SshRuntimeRecoveryService } from './shared/services/ssh-runtime-recovery.service';
import { BackendLogsWebsocketService } from './shared/services/backend-logs-websocket.service';
import { EnvironmentConnectionManagerService } from './shared/services/environment-connection-manager.service';
import { ThemeService } from './shared/services/theme.service';
import { ServerConnectionService } from './shared/services/server-connection.service';
import { AgentControlDrawerComponent } from './features/agent-control/agent-control-drawer.component';
import { ZardInputDirective } from './shared/components/input';

const SIDEBAR_MIN = 250;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 260;
const STORAGE_KEY = 'sidebar-width';

function readSidebarWidth(): number {
  try {
    return +(globalThis.localStorage?.getItem(STORAGE_KEY) ?? SIDEBAR_DEFAULT);
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, NgxSonnerToaster, Sidebar, NgIcon, RemoteInstallModalComponent, EnvironmentSwitcherComponent, AgentControlDrawerComponent, ZardInputDirective, TmuxRequiredOverlayComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCopy,
      lucideHardDrive,
      lucideLoader,
      lucideMinus,
      lucidePlay,
      lucideRefreshCw,
      lucideSquare,
      lucideTriangleAlert,
      lucideWifiOff,
      lucideX,
    }),
  ],
})
export class App implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly startupService = inject(OnboardingStartupService);
  private readonly sshRuntimeRecovery = inject(SshRuntimeRecoveryService);
  private readonly connectionManager = inject(EnvironmentConnectionManagerService);
  private readonly backendLogs = inject(BackendLogsWebsocketService);
  private readonly serverConnection = inject(ServerConnectionService);
  private readonly onboardingState = inject(OnboardingStateService);
  private readonly theme = inject(ThemeService);
  private readonly windowControls = getElectronWindowControlsApi();
  private readonly appControls = getElectronAppApi();
  private readonly runtimeMode = getRuntimeConfig().mode;

  sidebarWidth = signal(readSidebarWidth());
  isElectronDesktop = signal(false);
  usesNativeMacControls = signal(false);
  isMaximized = signal(false);
  isFullScreen = signal(false);
  isFocused = signal(false);
  remoteReconnectPassword = signal('');
  tmuxActionBusy = signal(false);
  windowEnvironmentReady = signal(false);
  isOnboardingRoute = signal(this.router.url.startsWith('/onboarding'));
  switchingEnvironment = this.connectionManager.switching;
  readonly startupPortForwardPrompt = this.startupService.startupPortForwardPrompt;
  readonly disconnectedForwardsBanner = this.sshRuntimeRecovery.disconnectedForwardsBanner;
  readonly remoteDisconnect = this.sshRuntimeRecovery.remoteDisconnect;
  readonly remoteConnecting = this.sshRuntimeRecovery.remoteConnecting;
  readonly connectingPhases = CONNECTING_PHASES;
  readonly serverConnectionState = this.serverConnection.state;
  readonly showServerConnectionOverlay = this.serverConnection.showOverlay;
  readonly showServerBlockOverlay = computed(() =>
    this.serverConnection.showOverlay() &&
    !this.sshRuntimeRecovery.remoteConnecting() &&
    !this.sshRuntimeRecovery.remoteDisconnect() &&
    !this.isOnboardingRoute(),
  );
  // tmux is a hard requirement: when the active backend reports it's missing we
  // block the workspace entirely. Only surfaces for a determinate backend (local,
  // or a remote that is actually connected) and never over onboarding/SSH overlays.
  readonly tmuxRequired = computed<{ mode: 'local' | 'remote'; platform: string } | null>(() => {
    if (this.isOnboardingRoute()) {
      return null;
    }
    if (this.sshRuntimeRecovery.remoteConnecting() || this.sshRuntimeRecovery.remoteDisconnect()) {
      return null;
    }
    const capabilities = this.serverConnection.capabilities();
    if (!capabilities || capabilities.tmuxAvailable) {
      return null;
    }

    const snapshot = this.onboardingState.snapshotState();
    if (snapshot.mode === 'ssh') {
      // Capabilities only reflect the remote host once the tunnel is active.
      if (!snapshot.remoteConnectionReady) {
        return null;
      }
      return { mode: 'remote', platform: capabilities.platform };
    }

    return { mode: 'local', platform: capabilities.platform };
  });
  readonly canRestartApp = computed(() => this.appControls !== null);
  readonly tmuxActionLabel = computed(() => {
    const block = this.tmuxRequired();
    if (block?.mode === 'remote') {
      return 'Reconnect';
    }
    return this.canRestartApp() ? 'Restart Elevenex' : 'Re-check';
  });

  private removeWindowListener: (() => void) | null = null;
  private removeRouteListener: (() => void) | null = null;

  async ngOnInit() {
    this.theme.mode();
    this.serverConnection.start();
    this.backendLogs.start();
    const subscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        const url = event.urlAfterRedirects;
        this.isOnboardingRoute.set(url.startsWith('/onboarding'));
      }
    });
    this.removeRouteListener = () => subscription.unsubscribe();

    if (!this.windowControls) {
      this.isElectronDesktop.set(this.runtimeMode === 'electron-local' || this.runtimeMode === 'electron-debug');
      this.windowEnvironmentReady.set(true);
      void this.startupService.initialize();
      await this.sshRuntimeRecovery.startMonitoring();
      return;
    }

    const [environment, state] = await Promise.all([
      this.windowControls.getEnvironment(),
      this.windowControls.isMaximized(),
    ]);
    this.isElectronDesktop.set(environment.isElectron);
    this.usesNativeMacControls.set(environment.usesNativeMacControls);
    this.syncWindowState(state);
    this.windowEnvironmentReady.set(true);

    this.removeWindowListener = this.windowControls.onStateChanged((nextState) => {
      this.syncWindowState(nextState);
    });
    void this.startupService.initialize();
    await this.sshRuntimeRecovery.startMonitoring();
  }

  ngOnDestroy() {
    this.removeWindowListener?.();
    this.removeRouteListener?.();
    this.sshRuntimeRecovery.stopMonitoring();
  }

  get shouldShowWindowControls(): boolean {
    return this.windowEnvironmentReady() && this.isElectronDesktop() && !this.usesNativeMacControls();
  }

  get shouldShowDesktopChrome(): boolean {
    return this.windowEnvironmentReady() && this.isElectronDesktop() && !this.usesNativeMacControls();
  }

  get shouldEnableWindowChromeInteractions(): boolean {
    return this.windowEnvironmentReady() && this.isElectronDesktop() && !!this.windowControls;
  }

  get shouldUseDesktopShellPadding(): boolean {
    return this.windowEnvironmentReady() && this.isElectronDesktop();
  }

  get shouldShowWorkspaceSidebar(): boolean {
    return !this.isOnboardingRoute();
  }

  get shouldReserveMacTrafficLightSpace(): boolean {
    return (
      this.windowEnvironmentReady() &&
      this.usesNativeMacControls() &&
      this.isFocused() &&
      !this.isFullScreen()
    );
  }

  async minimizeWindow() {
    await this.windowControls?.minimize();
  }

  async toggleMaximizeWindow() {
    const state = await this.windowControls?.toggleMaximize();
    if (state) {
      this.syncWindowState(state);
    }
  }

  async handleTopBarDoubleClick(event: MouseEvent) {
    if (!this.shouldEnableWindowChromeInteractions) {
      return;
    }

    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('button, a, input, textarea, select, option, [role="button"], [data-no-window-drag]')
    ) {
      return;
    }

    await this.toggleMaximizeWindow();
  }

  async closeWindow() {
    await this.windowControls?.close();
  }

  dismissStartupPortForwardPrompt() {
    this.startupService.dismissStartupPortForwardPrompt();
  }

  async startAllStartupForwards() {
    try {
      await this.startupService.startAllStartupPortForwards();
      toast.success('Forwarding started');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start forwarding.');
    }
  }

  dismissDisconnectedForwardsBanner() {
    this.sshRuntimeRecovery.dismissDisconnectedForwardsBanner();
  }

  async reconnectDisconnectedForwards() {
    const failures = await this.sshRuntimeRecovery.reconnectAllDisconnectedForwards();
    if (failures.length === 0) {
      toast.success('Forwarding restored');
      return;
    }

    if (failures.length === 1) {
      toast.error(failures[0].error.message || `Could not reconnect ${failures[0].name}.`);
      return;
    }

    toast.error(`${failures.length} port forwards could not be reconnected.`);
  }

  async retryRemoteConnection() {
    const disconnect = this.remoteDisconnect();
    if (disconnect?.server.authMode !== 'password') {
      await this.sshRuntimeRecovery.retryRemoteConnection();
      return;
    }

    const password = this.remoteReconnectPassword().trim();
    if (!password) {
      toast.error('Enter the SSH password to reconnect.');
      return;
    }

    await this.sshRuntimeRecovery.retryRemoteConnection({
      password,
    });

    if (!this.remoteDisconnect()) {
      this.clearRemoteReconnectCredentials();
    }
  }

  cancelRemoteConnection() {
    this.sshRuntimeRecovery.cancelRemoteConnection();
    this.clearRemoteReconnectCredentials();
  }

  async handleTmuxAction() {
    const block = this.tmuxRequired();
    if (!block || this.tmuxActionBusy()) {
      return;
    }

    this.tmuxActionBusy.set(true);
    try {
      if (block.mode === 'local' && this.appControls) {
        // Relaunches the desktop app; this process is replaced before we return.
        await this.appControls.restart();
        return;
      }

      // Remote, or local web/dev runtime without a relaunch bridge: reopen the
      // server connection so the backend re-advertises whether tmux is present.
      this.serverConnection.recheck();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not restart Elevenex.');
    } finally {
      this.tmuxActionBusy.set(false);
    }
  }

  async switchToLocalFromOverlay() {
    if (this.switchingEnvironment()) {
      return;
    }
    const result = await this.connectionManager.switchToLocal();
    if (!result.ok && result.error) {
      toast.error(result.error);
      return;
    }
    this.clearRemoteReconnectCredentials();
  }

  private clearRemoteReconnectCredentials() {
    this.remoteReconnectPassword.set('');
  }

  onResizeStart(event: MouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.sidebarWidth();

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      this.sidebarWidth.set(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + delta)));
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, String(this.sidebarWidth()));
      } catch {
        // Ignore unavailable storage in restricted runtimes.
      }
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  private syncWindowState(state: ElectronWindowState) {
    this.isMaximized.set(state.isMaximized);
    this.isFullScreen.set(state.isFullScreen);
    this.isFocused.set(state.isFocused);
  }
}
