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
import {
  EnvironmentConnectionManagerService,
  SavedServerDraft,
} from '@/shared/services/environment-connection-manager.service';
import { OnboardingConnectionService } from '@/shared/services/onboarding-connection.service';
import {
  CONNECTING_PHASES,
  SshRuntimeRecoveryService,
  remoteInstallPhaseToIndex,
} from '@/shared/services/ssh-runtime-recovery.service';

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
  readonly switchingId = signal<number | 'local' | null>(null);

  readonly statusVariant = computed(() => {
    if (this.switching()) return 'switching';
    if (this.remoteDisconnect()) return 'degraded';
    return this.snapshot().mode === 'ssh' ? 'remote' : 'local';
  });

  readonly triggerLabel = computed(() => this.connectionManager.environmentLabel());
  readonly triggerSubtitle = computed(() => {
    if (this.switching()) return 'Switching…';
    if (this.remoteDisconnect()) return 'Connection lost';
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
      const rect = this.triggerEl?.nativeElement?.getBoundingClientRect();
      if (rect) {
        this.popoverPos.set({
          top: `${rect.bottom + 7}px`,
          left: `${rect.left}px`,
          width: `${rect.width}px`,
        });
      }
    }
    this.open.update(v => !v);
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

  async selectLocal() {
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

  async selectServer(server: SavedServer) {
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
    this.expansion.set({ kind: 'delete', serverId: server.id });
  }

  confirmDelete(server: SavedServer, event: Event) {
    event.stopPropagation();
    this.connectionManager.deleteServer(server.id);
    this.expansion.set(null);
    toast.success('Server removed');
  }

  // ----- Expansion helpers -----

  isExpanded(server: SavedServer, kind: 'password' | 'delete'): boolean {
    const exp = this.expansion();
    return !!exp && exp.kind === kind && exp.serverId === server.id;
  }

  trackServer(_index: number, server: SavedServer) {
    return server.id;
  }
}
