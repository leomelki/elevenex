import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import type { EnvironmentSelection, MachineEditInput, MachineState, RemoteHostInput } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../../backend/backend-client.service';

/** Window-scoped platform adapter. Feature selection and drafts stay in their owners. */
@Injectable()
export class MachineConnectionService {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly current = signal<MachineState | null>(null);
  private readonly failure = signal('');
  private disposed = false;
  private reading?: Promise<void>;
  readonly state = this.current.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly platform = this.bridge.platform;

  constructor() {
    const stop = this.bridge.onMachineStateChanged(state => this.accept(state));
    inject(DestroyRef).onDestroy(() => { this.disposed = true; stop(); });
    void this.refresh();
  }

  refresh(): Promise<void> {
    return this.reading ??= this.bridge.machineState().then(state => {
      this.accept(state);
      if (!this.disposed) this.failure.set('');
    }, () => {
      if (!this.disposed && !this.current()) this.failure.set('Machines could not be loaded. Try again.');
    }).finally(() => { this.reading = undefined; });
  }

  async select(selection: EnvironmentSelection): Promise<void> {
    await this.bridge.selectEnvironment(selection);
    await this.refresh();
  }
  async retry(): Promise<void> {
    const selection = this.current()?.environment.selection;
    if (!selection) return;
    if (selection.kind === 'local') await this.bridge.retryBackend();
    else await this.bridge.retryRemote();
    await this.refresh();
  }
  async disconnect(): Promise<void> { await this.bridge.disconnectRemote(); await this.refresh(); }
  async opened(selection: EnvironmentSelection): Promise<void> { this.accept(await this.bridge.markMachineOpened(selection)); }
  async addHost(input: RemoteHostInput) {
    const host = await this.bridge.saveRemoteHost(input, null);
    await this.refresh();
    return host;
  }
  suggestions(query: string) { return this.bridge.sshHostSuggestions(query); }
  newWindow(selection: EnvironmentSelection | null): Promise<void> { return this.bridge.openMachineWindow(selection); }
  async edit(selection: EnvironmentSelection, input: MachineEditInput): Promise<void> { this.accept(await this.bridge.editMachine(selection, input)); }
  async disconnectMachine(id: string): Promise<void> { this.accept(await this.bridge.disconnectMachine(id)); }
  async remove(id: string, confirmWindows: boolean): Promise<string> {
    const removal = await this.bridge.removeMachine(id, confirmWindows);
    this.accept(removal.state); return removal.undoToken;
  }
  async undoRemoval(token: string): Promise<void> { this.accept(await this.bridge.undoRemoveMachine(token)); }
  dismissRemoval(token: string): Promise<void> { return this.bridge.dismissMachineRemoval(token); }
  chooseIdentity(): Promise<string | null> { return this.bridge.chooseRemoteSshFile('identity'); }
  async answer(id: string, answer: string | null): Promise<void> {
    const challenge = this.current()?.environment.challenge;
    if (!challenge || challenge.id !== id || challenge.expiresAt <= Date.now()) throw new Error('This connection prompt has expired. Retry the connection.');
    await this.bridge.answerRemoteChallenge(id, answer);
  }

  private accept(state: MachineState): void {
    if (!this.disposed && state.revision > (this.current()?.revision ?? -1)) {
      this.current.set(state);
      this.failure.set('');
    }
  }
}
