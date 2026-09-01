import {
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideAppWindow,
  lucideArrowLeft,
  lucideCheck,
  lucideChevronsUpDown,
  lucideFolderOpen,
  lucideHardDrive,
  lucideKeyRound,
  lucideLock,
  lucidePencil,
  lucidePlus,
  lucideRefreshCw,
  lucideServer,
  lucideTrash2,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardInputDirective } from '@/shared/components/input';
import { PathAutocompleteInputComponent } from '@/shared/components/path-autocomplete-input/path-autocomplete-input.component';
import { SavedServer, ServerAuthMode } from '@/shared/models/onboarding.model';
import { getElectronWindowControlsApi } from '@/shared/runtime/electron-window-controls';
import {
  EnvironmentConnectionManagerService,
  SavedServerDraft,
} from '@/shared/services/environment-connection-manager.service';
import { OpenWindowsService } from '@/shared/services/open-windows.service';
import { OnboardingConnectionService } from '@/shared/services/onboarding-connection.service';
import { RemoteInstallFlowService } from '@/shared/services/remote-install-flow.service';
import {
  CONNECTING_PHASES,
  SshRuntimeRecoveryService,
  remoteInstallPhaseToIndex,
} from '@/shared/services/ssh-runtime-recovery.service';
import { WslInstallFlowService } from '@/shared/services/wsl-install-flow.service';

type PopoverView = 'list' | 'editor';
type RowExpansion =
  | { kind: 'password'; serverId: number }
  | { kind: 'delete'; serverId: number }
  | null;

function createEmptyDraft(): SavedServerDraft {
  return {
    name: '',
    sshHost: '',
    sshUser: '',
    sshPort: 22,
    authMode: 'agent',
    identityFilePath: '',
  };
}

@Component({
  selector: 'app-environment-switcher',
  imports: [NgIcon, ZardInputDirective, PathAutocompleteInputComponent],
  templateUrl: './environment-switcher.component.html',
  styleUrl: './environment-switcher.component.scss',
  viewProviders: [
    provideIcons({
      lucideAppWindow,
      lucideArrowLeft,
      lucideCheck,
      lucideChevronsUpDown,
      lucideFolderOpen,
      lucideHardDrive,
      lucideKeyRound,
      lucideLock,
      lucidePencil,
      lucidePlus,
      lucideRefreshCw,
      lucideServer,
      lucideTrash2,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
})
export class EnvironmentSwitcherComponent {
  private readonly connectionManager = inject(EnvironmentConnectionManagerService);
  private readonly onboardingConnection = inject(OnboardingConnectionService);
  private readonly sshRuntimeRecovery = inject(SshRuntimeRecoveryService);
  private readonly remoteInstallFlow = inject(RemoteInstallFlowService);
  private readonly wslInstallFlow = inject(WslInstallFlowService);
  private readonly openWindows = inject(OpenWindowsService);
  private readonly host = inject(ElementRef<HTMLElement>);

  @ViewChild('trigger') triggerEl?: ElementRef<HTMLButtonElement>;

  readonly snapshot = this.connectionManager.snapshot;
  readonly activeServer = this.connectionManager.activeServer;
  readonly savedServers = this.connectionManager.savedServers;
  readonly switching = this.connectionManager.switching;
  readonly switchError = this.connectionManager.switchError;
  readonly remoteDisconnect = this.sshRuntimeRecovery.remoteDisconnect;
  readonly pendingTargetLabel = this.connectionManager.pendingTargetLabel;
  readonly connectingPhases = CONNECTING_PHASES;
  readonly connectingPhaseIndex = computed(() =>
    remoteInstallPhaseToIndex(this.onboardingConnection.currentPhase()),
  );

  readonly open = signal(false);
  readonly popoverPos = signal({ top: '0px', left: '0px', width: '0px' });
  readonly view = signal<PopoverView>('list');
  readonly editingServerId = signal<number | 'new' | null>(null);
  readonly draft = signal<SavedServerDraft>(createEmptyDraft());
  readonly expansion = signal<RowExpansion>(null);
  readonly password = signal('');
  readonly passphrase = signal('');
  readonly switchingId = signal<number | 'local' | 'wsl' | null>(null);
  // Whether wsl.exe is present on this Windows machine — checked lazily each
  // time the popover opens, since it can change without restarting Elevenex
  // (e.g. the user just ran `wsl --install`). The row itself is always shown
  // on Windows regardless of this value; it only toggles the disabled/hint state.
  readonly wslAvailable = signal(false);
  readonly isWindows = signal(false);

  readonly statusVariant = computed(() => {
    if (this.switching()) return 'switching';
    if (this.remoteDisconnect()) return 'degraded';
    return this.snapshot().mode === 'ssh' || this.snapshot().mode === 'wsl' ? 'remote' : 'local';
  });

  readonly triggerLabel = computed(() => this.connectionManager.environmentLabel());
  readonly triggerSubtitle = computed(() => {
    if (this.switching()) return 'Switching…';
    if (this.remoteDisconnect()) return 'Connection lost';
    if (this.snapshot().mode === 'wsl') {
      return this.snapshot().wsl?.distroName || 'WSL';
    }
    const server = this.activeServer();
    if (!server || this.snapshot().mode !== 'ssh') return 'Local workspace';
    return server.sshUser ? `${server.sshUser}@${server.sshHost}` : server.sshHost;
  });

  readonly draftValid = computed(() => {
    const draft = this.draft();
    if (!draft.sshHost.trim()) return false;
    if (!Number.isInteger(draft.sshPort) || draft.sshPort <= 0 || draft.sshPort > 65535) return false;
    if (draft.authMode === 'key' && !draft.identityFilePath?.trim()) return false;
    return true;
  });

  readonly editingCurrentServer = computed(() => {
    const id = this.editingServerId();
    if (id === null || id === 'new') return false;
    const server = this.savedServers().find(s => s.id === id);
    return server ? this.isCurrent(server) : false;
  });

  constructor() {
    effect(() => {
      if (!this.open()) {
        this.view.set('list');
        this.expansion.set(null);
        this.editingServerId.set(null);
        this.password.set('');
        this.passphrase.set('');
        this.connectionManager.clearError();
      }
    });

    // The SSH/WSL "finish setting up" dialogs are full-screen modals that must
    // sit above everything else; this popover has no way to know they're about
    // to open (switchToServer/switchToWsl only resolve after the modal already
    // did), so close it eagerly whenever either flow's session state appears.
    effect(() => {
      if (this.remoteInstallFlow.state() || this.wslInstallFlow.state()) {
        this.open.set(false);
      }
    });

    void getElectronWindowControlsApi()
      ?.getEnvironment()
      .then(environment => this.isWindows.set(environment.platform === 'win32'));
    void this.refreshWslAvailability();
  }

  private async refreshWslAvailability(): Promise<void> {
    this.wslAvailable.set(await this.connectionManager.isWslSupported());
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent) {
    if (!this.open()) return;
    if (this.switching()) return;
    const target = event.target as Node | null;
    if (target && this.host.nativeElement.contains(target)) return;
    this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (!this.open()) return;
    if (this.switching()) return;
    if (this.view() === 'editor') {
      this.cancelEditor();
      return;
    }
    if (this.expansion()) {
      this.expansion.set(null);
      return;
    }
    this.open.set(false);
  }

  toggle() {
    if (this.open() && this.switching()) return;
    if (!this.open()) {
      this.recomputePosition();
      void this.refreshWslAvailability();
    }
    this.open.update(v => !v);
  }

  private recomputePosition() {
    const rect = this.triggerEl?.nativeElement?.getBoundingClientRect();
    if (!rect) return;

    const margin = 8;
    const gap = 7;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Match CSS: min-width 18rem, max-height 70vh. Use the larger of trigger
    // width and 18rem so the popover never appears narrower than its content.
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const popoverWidth = Math.max(rect.width, 18 * remPx);
    const estimatedHeight = Math.min(viewportHeight * 0.7, 480);

    let left = rect.left;
    if (left + popoverWidth + margin > viewportWidth) {
      left = Math.max(margin, viewportWidth - popoverWidth - margin);
    }
    if (left < margin) left = margin;

    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;
    const placeAbove = spaceBelow < estimatedHeight + gap + margin && spaceAbove > spaceBelow;
    const top = placeAbove
      ? Math.max(margin, rect.top - gap - estimatedHeight)
      : rect.bottom + gap;

    this.popoverPos.set({
      top: `${top}px`,
      left: `${left}px`,
      width: `${popoverWidth}px`,
    });
  }

  @HostListener('window:resize')
  @HostListener('window:scroll')
  onViewportChange() {
    if (this.open()) {
      this.recomputePosition();
    }
  }

  close() {
    if (this.switching()) return;
    this.open.set(false);
  }

  isCurrent(server: SavedServer): boolean {
    return this.snapshot().mode === 'ssh' && this.snapshot().activeServerId === server.id;
  }

  isLocalActive(): boolean {
    return this.snapshot().mode === 'local';
  }

  isWslActive(): boolean {
    return this.snapshot().mode === 'wsl';
  }

  authLabel(mode: ServerAuthMode) {
    switch (mode) {
      case 'agent':
        return 'SSH agent';
      case 'key':
        return 'Private key';
      case 'password':
        return 'Password';
    }
  }

  installStatusLabel(status: SavedServer['installStatus']) {
    switch (status) {
      case 'missing':
        return 'Install missing';
      case 'needs-update':
        return 'Update needed';
      case 'missing-prereqs':
        return 'Setup needed';
      case 'unsupported-os':
        return 'Unsupported';
      default:
        return '';
    }
  }

  // ----- Row actions -----

  async selectLocal(event?: Event) {
    if (event && this.handleRowActivate('local', event)) return;
    if (this.isLocalActive()) {
      this.close();
      return;
    }
    this.connectionManager.clearError();
    this.switchingId.set('local');
    const result = await this.connectionManager.switchToLocal();
    this.switchingId.set(null);
    if (result.ok) {
      this.close();
    }
  }

  async selectWsl(event?: Event) {
    if (event && this.handleRowActivate('wsl', event)) return;
    if (this.isWslActive() && this.snapshot().remoteConnectionReady) {
      this.close();
      return;
    }
    this.connectionManager.clearError();
    this.switchingId.set('wsl');
    const result = await this.connectionManager.switchToWsl();
    this.switchingId.set(null);
    if (result.ok) {
      this.close();
    }
  }

  async selectServer(server: SavedServer, event?: Event) {
    if (event && this.handleRowActivate(server, event)) return;
    if (this.isCurrent(server) && this.snapshot().remoteConnectionReady) {
      this.close();
      return;
    }

    this.connectionManager.clearError();

    if (server.authMode === 'password') {
      this.expansion.set({ kind: 'password', serverId: server.id });
      this.password.set('');
      this.passphrase.set('');
      return;
    }

    this.switchingId.set(server.id);
    const result = await this.connectionManager.switchToServer(server);
    this.switchingId.set(null);
    if (result.ok) {
      this.close();
    }
  }

  async connectWithPassword(server: SavedServer) {
    if (!this.password().trim()) return;
    this.switchingId.set(server.id);
    const result = await this.connectionManager.switchToServer(server, {
      password: this.password(),
      passphrase: this.passphrase() || undefined,
    });
    this.switchingId.set(null);
    if (result.ok) {
      this.close();
    }
  }

  cancelExpansion() {
    this.expansion.set(null);
    this.password.set('');
    this.passphrase.set('');
  }

  // ----- Edit / Delete -----

  beginCreate(event?: Event) {
    event?.stopPropagation();
    this.draft.set(createEmptyDraft());
    this.editingServerId.set('new');
    this.expansion.set(null);
    this.view.set('editor');
    this.connectionManager.clearError();
  }

  beginEdit(server: SavedServer, event: Event) {
    event.stopPropagation();
    this.draft.set({
      id: server.id,
      name: server.name,
      sshHost: server.sshHost,
      sshUser: server.sshUser,
      sshPort: server.sshPort,
      authMode: server.authMode,
      identityFilePath: server.identityFilePath,
    });
    this.editingServerId.set(server.id);
    this.expansion.set(null);
    this.view.set('editor');
    this.connectionManager.clearError();
  }

  cancelEditor() {
    this.editingServerId.set(null);
    this.draft.set(createEmptyDraft());
    this.view.set('list');
  }

  updateDraft<K extends keyof SavedServerDraft>(field: K, value: SavedServerDraft[K]) {
    this.draft.update(current => ({ ...current, [field]: value }));
  }

  async pickIdentityFile() {
    const path = await this.onboardingConnection.pickIdentityFile();
    if (path) this.updateDraft('identityFilePath', path);
  }

  saveDraft() {
    if (!this.draftValid()) return;
    const isEditing = this.editingServerId() !== 'new';
    this.connectionManager.saveServerDraft(this.draft());
    this.editingServerId.set(null);
    this.draft.set(createEmptyDraft());
    this.view.set('list');
    toast.success(isEditing ? 'Server updated' : 'Server saved');
  }

  requestDelete(server: SavedServer, event: Event) {
    event.stopPropagation();
    if (this.isCurrent(server)) return;

    // Refuse up front rather than after the confirmation step — asking the user
    // to confirm something that will then be rejected is worse than not
    // offering it.
    const blocker = this.connectionManager.serverDeletionBlocker(server.id);
    if (blocker) {
      this.showDeletionBlockedToast(server, blocker.windowId);
      return;
    }

    this.expansion.set({ kind: 'delete', serverId: server.id });
  }

  confirmDelete(server: SavedServer, event: Event) {
    event.stopPropagation();
    const result = this.connectionManager.deleteServer(server.id);
    this.expansion.set(null);

    if (!result.ok) {
      // A window may have opened this server between the request and the
      // confirmation.
      this.showDeletionBlockedToast(server, result.windowId);
      return;
    }

    toast.success('Server removed');
  }

  private showDeletionBlockedToast(server: SavedServer, windowId?: string) {
    const name = server.name || server.sshHost;
    toast.error(`“${name}” is open in another window`, {
      description: 'Close that window, or switch it to another environment, before removing this server.',
      ...(windowId
        ? {
          action: {
            label: 'Show window',
            onClick: () => void this.focusOtherWindow(windowId),
          },
        }
        : {}),
    });
  }

  // ----- Expansion helpers -----

  isExpanded(server: SavedServer, kind: 'password' | 'delete'): boolean {
    const exp = this.expansion();
    return !!exp && exp.kind === kind && exp.serverId === server.id;
  }

  trackServer(_index: number, server: SavedServer) {
    return server.id;
  }

  // ----- Multiple windows -----

  readonly multiWindowSupported = this.openWindows.isMultiWindowSupported;
  readonly openWindowList = this.openWindows.windows;
  readonly hasOtherWindows = this.openWindows.hasOtherWindows;
  readonly currentWindowId = this.openWindows.currentWindowId;

  /**
   * Windows *other than this one* already showing an environment. Drives the
   * "Open" chip, which is what makes the shared-tunnel and blocked-delete
   * behaviours legible rather than mysterious.
   */
  private otherWindowsOn(server: SavedServer | 'local' | 'wsl'): string[] {
    const env = server === 'local'
      ? ({ mode: 'local', serverId: null } as const)
      : server === 'wsl'
        ? ({ mode: 'wsl', serverId: null } as const)
        : ({ mode: 'ssh', serverId: server.id } as const);

    return this.openWindows.othersOn(env).map(entry => entry.label);
  }

  openElsewhereLabels(server: SavedServer | 'local' | 'wsl'): string[] {
    return this.otherWindowsOn(server);
  }

  isOpenElsewhere(server: SavedServer | 'local' | 'wsl'): boolean {
    return this.otherWindowsOn(server).length > 0;
  }

  openElsewhereTooltip(server: SavedServer | 'local' | 'wsl'): string {
    const labels = this.otherWindowsOn(server);
    return labels.length === 0
      ? ''
      : `Already open in ${labels.length} other window${labels.length > 1 ? 's' : ''}`;
  }

  async openInNewWindow(target: 'current' | 'local' | 'wsl' | SavedServer, event?: Event) {
    event?.stopPropagation();
    const result = await this.connectionManager.openInNewWindow(target);
    if (!result.ok) {
      toast.error(result.error ?? 'Could not open a new window.');
      return;
    }
    this.close();
  }

  /**
   * Alt/Option-click opens the row in a new window instead of switching this
   * one — the same modifier VS Code uses for "open to the side".
   */
  handleRowActivate(target: 'local' | 'wsl' | SavedServer, event: Event) {
    // Angular types keydown/click handlers as a bare Event, so read the
    // modifier defensively rather than casting.
    const altKey = 'altKey' in event && (event as MouseEvent | KeyboardEvent).altKey;
    if (this.multiWindowSupported && altKey) {
      void this.openInNewWindow(target, event);
      return true;
    }
    return false;
  }

  async focusOtherWindow(windowId: string) {
    await this.openWindows.focusWindow(windowId);
    this.close();
  }

  trackWindow(_index: number, entry: { windowId: string }) {
    return entry.windowId;
  }
}
