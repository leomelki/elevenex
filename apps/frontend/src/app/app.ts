import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
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
  getElectronWindowControlsApi,
} from './shared/runtime/electron-window-controls';
import { OnboardingStartupService } from './shared/services/onboarding-startup.service';
import { CONNECTING_PHASES, SshRuntimeRecoveryService } from './shared/services/ssh-runtime-recovery.service';
import { BackendLogsWebsocketService } from './shared/services/backend-logs-websocket.service';
import { EnvironmentConnectionManagerService } from './shared/services/environment-connection-manager.service';
import { PlannotatorInstallPromptService } from './features/plannotator/plannotator-install-prompt.service';
import { PlannotatorInstallPromptComponent } from './features/plannotator/plannotator-install-prompt.component';
import { ThemeService } from './shared/services/theme.service';

const SIDEBAR_MIN = 250;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 260;
const STORAGE_KEY = 'sidebar-width';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, NgxSonnerToaster, Sidebar, NgIcon, RemoteInstallModalComponent, PlannotatorInstallPromptComponent, EnvironmentSwitcherComponent],
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
  private readonly plannotatorInstallPrompt = inject(PlannotatorInstallPromptService);
  private readonly theme = inject(ThemeService);
  private readonly windowControls = getElectronWindowControlsApi();
  private readonly runtimeMode = getRuntimeConfig().mode;

  sidebarWidth = signal(+(localStorage.getItem(STORAGE_KEY) ?? SIDEBAR_DEFAULT));
  isElectronDesktop = signal(false);
  usesNativeMacControls = signal(false);
  isMaximized = signal(false);
  isFullScreen = signal(false);
  isFocused = signal(false);
  windowEnvironmentReady = signal(false);
  isOnboardingRoute = signal(this.router.url.startsWith('/onboarding'));
  switchingEnvironment = this.connectionManager.switching;
  readonly startupPortForwardPrompt = this.startupService.startupPortForwardPrompt;
  readonly showPlannotatorInstallPrompt = this.plannotatorInstallPrompt.show;
  readonly disconnectedForwardsBanner = this.sshRuntimeRecovery.disconnectedForwardsBanner;
  readonly remoteDisconnect = this.sshRuntimeRecovery.remoteDisconnect;
  readonly remoteConnecting = this.sshRuntimeRecovery.remoteConnecting;
  readonly connectingPhases = CONNECTING_PHASES;

  private removeWindowListener: (() => void) | null = null;
  private removeRouteListener: (() => void) | null = null;

  async ngOnInit() {
    this.theme.mode();
    this.backendLogs.start();
    this.plannotatorInstallPrompt.initialize();

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
    await this.sshRuntimeRecovery.retryRemoteConnection();
  }

  cancelRemoteConnection() {
    this.sshRuntimeRecovery.cancelRemoteConnection();
  }

  async switchToLocalFromOverlay() {
    if (this.switchingEnvironment()) {
      return;
    }
    const result = await this.connectionManager.switchToLocal();
    if (!result.ok && result.error) {
      toast.error(result.error);
    }
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
      localStorage.setItem(STORAGE_KEY, String(this.sidebarWidth()));
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
