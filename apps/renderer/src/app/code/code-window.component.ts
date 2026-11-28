import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import type { CodeTarget, CodeWindowContext, RemoteChallenge } from '@elevenex/shared';
import { BackendClientService, ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { MachineConnectionService, RemoteChallengeDialogComponent, TitleBarComponent, TitleIslandComponent } from '../machines';
import { ButtonComponent, IconComponent, ModalLayerComponent } from '../ui';
import { CodePanelComponent } from './code-panel.component';

/** A task-only desktop window with its own selected-machine lease and sign-in UI. */
@Component({
  selector: 'ex-code-window', providers: [MachineConnectionService],
  imports: [CodePanelComponent, ButtonComponent, IconComponent, TitleBarComponent, TitleIslandComponent, ModalLayerComponent, RemoteChallengeDialogComponent],
  templateUrl: './code-window.component.html', styleUrl: './code-window.component.css', changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodeWindowComponent {
  readonly connection = inject(MachineConnectionService);
  private readonly backend = inject(BackendClientService);
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  readonly context = signal<CodeWindowContext | null>(null);
  readonly target = signal<CodeTarget | null>(null);
  readonly error = signal('');
  readonly panelOpen = signal(false);
  readonly challengeBusy = signal(false);
  readonly challengeError = signal('');
  readonly retainedChallenge = signal<RemoteChallenge | null>(null);
  readonly challenge = computed(() => this.connection.state()?.environment.challenge ?? null);
  readonly connected = computed(() => !!this.backend.state().scope);
  readonly machineName = computed(() => {
    const context = this.context(), state = this.connection.state();
    const selection = context?.selection;
    return selection?.kind === 'remote' ? state?.hosts.find(host => host.id === selection.hostId)?.name ?? context?.machineName ?? 'Remote machine' : state?.localAppearance?.name || (this.bridge.platform === 'darwin' ? 'This Mac' : context?.machineName ?? 'This machine');
  });
  private destroyed = false;
  constructor() {
    inject(DestroyRef).onDestroy(() => { this.destroyed = true; });
    void this.bridge.codeWindowContext().then(context => { if (!this.destroyed) { this.context.set(context); this.target.set(context?.target ?? null); if (!context) this.error.set('This editor window is no longer available. Open Code from a task.'); } }, () => { if (!this.destroyed) this.error.set('Editor context could not load. Open Code from a task.'); });
    effect(() => { const scope = this.backend.state().scope, context = this.context(); if (scope && context) untracked(() => this.target.set({ scopeId: scope.id, taskId: context.target.taskId })); });
    // Retention owns the closing modal's data; it is released only after exit.
    effect(() => { const challenge = this.challenge(); if (challenge && this.retainedChallenge()?.id !== challenge.id) this.retainedChallenge.set(challenge); });
  }
  async retry(): Promise<void> { try { await this.connection.retry(); } catch { this.error.set('The machine could not reconnect. Try again.'); } }
  async answer(intent: { readonly id: string; readonly answer: string | null }): Promise<void> {
    if (this.challenge()?.id !== intent.id || this.challengeBusy()) return;
    this.challengeBusy.set(true); this.challengeError.set('');
    try { await this.connection.answer(intent.id, intent.answer); }
    catch { if (!this.destroyed) this.challengeError.set('Sign-in could not complete. Retry the connection.'); }
    finally { if (!this.destroyed) this.challengeBusy.set(false); }
  }
  cancelChallenge(): void { const challenge = this.challenge(); if (challenge) void this.answer({ id: challenge.id, answer: null }); }
  openWorkspace(): void { const context = this.context(); if (context) void this.connection.newWindow(context.selection).catch(() => this.error.set('Workspace window could not open.')); }
}
