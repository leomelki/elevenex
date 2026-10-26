import type { EnvironmentSelection, MachineEditInput, MachineRemoval, MachineState, RemoteHost } from '@elevenex/shared';
import { randomUUID } from 'node:crypto';
import type { BackendManager } from '../backend/manager';
import type { RemoteManager } from '../remote/manager';
import { MachinePreferences } from './preferences';
import { id, selection as validateSelection } from '../remote/validation';
import { editInput } from './validation';

/** Composes lifecycle data; owns no engine or SSH process. Windows own their leases. */
export class MachineApplication {
  private readonly windows = new Map<number, { revision: number; launchSelection: EnvironmentSelection | null }>();
  private readonly stops: readonly (() => void)[];
  private readonly removals = new Map<string, { readonly windowId: number; readonly host: RemoteHost; readonly index: number }>();
  constructor(
    private readonly backend: BackendManager,
    private readonly remote: RemoteManager,
    private readonly preferences: MachinePreferences,
    private readonly changed: (windowId: number, state: MachineState) => void,
  ) {
    this.stops = [backend.subscribe(() => this.publish()), remote.subscribeDirectory(() => this.publish())];
  }
  attach(windowId: number, launchSelection: EnvironmentSelection | null = null): void {
    this.windows.set(windowId, { revision: 0, launchSelection });
  }
  detach(windowId: number): void { this.windows.delete(windowId); for (const [token, removal] of this.removals) if (removal.windowId === windowId) this.removals.delete(token); }
  dispose(): void { for (const stop of this.stops) stop(); this.windows.clear(); this.removals.clear(); }

  snapshot(windowId: number): MachineState {
    const window = this.windows.get(windowId);
    if (!window) throw new Error('Window is no longer available');
    let hosts: MachineState['hosts'] = [];
    let settingsError = this.preferences.error;
    try { hosts = this.remote.hosts(); }
    catch { settingsError = 'Saved machines could not be read. Your saved settings have been preserved.'; }
    return { revision: window.revision, hasOpenedMachine: this.preferences.hasOpenedMachine, settingsError,
      localAppearance: this.preferences.localAppearance,
      hosts, remoteMachines: this.remote.machineStatuses(), localBackend: this.backend.snapshot(), environment: this.remote.snapshot(windowId), launchSelection: window.launchSelection };
  }

  async edit(windowId: number, selection: EnvironmentSelection, input: MachineEditInput): Promise<MachineState> {
    this.snapshot(windowId);
    const target = this.validateSelection(selection);
    if (!target) throw new Error('Invalid machine selection');
    const patch = editInput(input, target?.kind === 'remote');
    if (target?.kind === 'remote') {
      const before = this.remote.hosts().find(host => host.id === target.hostId);
      if (!before || !patch.host) throw new Error('Unknown saved machine');
      await this.remote.editMachineHost(windowId, { name: patch.name, hue: patch.hue, host: patch.host, user: patch.user, port: patch.port,
        identityFile: patch.identityFile === undefined ? before.identityFile : patch.identityFile ?? undefined, configFile: before.configFile }, target.hostId);
    } else await this.preferences.saveAppearance({ name: patch.name, hue: patch.hue });
    this.publish(); return this.snapshot(windowId);
  }

  async disconnect(windowId: number, hostId: string): Promise<MachineState> {
    this.snapshot(windowId); await this.remote.disconnectMachineHost(id(hostId)); return this.snapshot(windowId);
  }

  async remove(windowId: number, hostId: string, confirmWindows: boolean): Promise<MachineRemoval> {
    this.snapshot(windowId);
    if (typeof confirmWindows !== 'boolean') throw new Error('Invalid removal confirmation');
    const removal = await this.remote.removeMachineHost(id(hostId), confirmWindows);
    const undoToken = randomUUID();
    if (!this.windows.has(windowId)) throw new Error('Window is no longer available');
    const previous = [...this.removals.entries()].filter(([, value]) => value.windowId === windowId);
    for (const [token] of previous.slice(0, Math.max(0, previous.length - 2))) this.removals.delete(token);
    this.removals.set(undoToken, { windowId, ...removal });
    return { state: this.snapshot(windowId), undoToken };
  }

  async undoRemove(windowId: number, token: string): Promise<MachineState> {
    const removal = this.removals.get(id(token));
    if (!removal || removal.windowId !== windowId) throw new Error('This Undo is no longer available');
    // Consume before awaiting: a duplicate invocation cannot restore it twice.
    this.removals.delete(token);
    try { await this.remote.restoreMachineHost(removal.host, removal.index); }
    catch (error) { if (this.windows.has(windowId)) this.removals.set(token, removal); throw error; }
    return this.snapshot(windowId);
  }

  dismissRemoval(windowId: number, token: string): void {
    const removal = this.removals.get(id(token));
    if (removal?.windowId === windowId) this.removals.delete(token);
  }

  validateSelection(input: EnvironmentSelection | null): EnvironmentSelection | null {
    if (input === null) return null;
    const selection = validateSelection(input);
    if (selection.kind === 'remote' && !this.remote.hosts().some(host => host.id === selection.hostId)) throw new Error('Unknown saved machine');
    return selection;
  }

  async opened(windowId: number, input: EnvironmentSelection): Promise<MachineState> {
    const expected = this.validateSelection(input);
    const current = this.remote.snapshot(windowId).selection;
    if (!expected || expected.kind !== current.kind || expected.kind === 'remote' && (current.kind !== 'remote' || expected.hostId !== current.hostId)) throw new Error('The selected machine changed');
    if (this.remote.backendStatus(windowId, this.backend.snapshot()).phase !== 'ready') throw new Error('The machine is not ready');
    await this.preferences.markOpened();
    const window = this.windows.get(windowId);
    if (!window) throw new Error('Window is no longer available');
    window.launchSelection = null;
    this.publish();
    return this.snapshot(windowId);
  }

  private publish(): void {
    for (const [id, window] of this.windows) {
      ++window.revision;
      this.changed(id, this.snapshot(id));
    }
  }
}
