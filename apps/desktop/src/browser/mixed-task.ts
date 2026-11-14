import type { BrowserWindow, WebContents } from 'electron';
import type { TaskBrowserCommand, TaskBrowserLayout, TaskBrowserState, TaskBrowserStreamInput, TaskBrowserSurface } from '@elevenex/shared';
import type { MachineBrowserHost, DesktopBrowserHost } from './host';

/** One task/tab strip, two isolated engines. Local guests never join agent automation. */
export class MixedTaskBrowser implements MachineBrowserHost {
  readonly engine = 'machine';
  readonly guests: Pick<DesktopBrowserHost, 'hasContents' | 'attach'>;
  private ready = false;
  private localActive = false;
  private disposed = false;
  private revision = 0;
  private selection = 0;
  private epoch = 0;
  private displayIdentity = '';
  private order: string[] = [];
  private readonly machine: MachineBrowserHost;
  private readonly local: DesktopBrowserHost;
  constructor(readonly scopeId: string, readonly taskId: number,
    createMachine: (changed: () => void) => MachineBrowserHost,
    createLocal: (changed: () => void) => DesktopBrowserHost,
    private readonly changed: (state: TaskBrowserState) => void) {
    this.machine = createMachine(() => this.update());
    try { this.local = createLocal(() => this.update()); }
    catch (error) { this.machine.destroy(); throw error; }
    this.guests = { hasContents: id => this.local.hasContents(id), attach: (contents: WebContents, id: string) => this.local.attach(contents, id) };
  }
  get closed(): boolean { return this.disposed || this.machine.closed || this.local.closed; }
  private get current() { return this.localActive ? this.local : this.machine; }
  private owner(tabId: string) {
    if (this.local.snapshot().tabs.some(tab => tab.id === tabId)) return this.local;
    if (this.machine.snapshot().tabs.some(tab => tab.id === tabId)) return this.machine;
    throw new Error('Browser tab closed');
  }
  async restore(): Promise<void> {
    await this.machine.restore(); await this.local.restore();
    this.localActive = !this.machine.snapshot().tabs.length && !!this.local.snapshot().tabs.length;
    this.ready = true; this.update();
  }
  async refresh(): Promise<void> { await this.machine.refresh(); this.update(); }
  private update(): void {
    if (!this.ready || this.disposed) return;
    const machine = this.machine.snapshot(), local = this.local.snapshot();
    const tabs = [...machine.tabs, ...local.tabs], ids = new Set(tabs.map(tab => tab.id));
    this.order = [...this.order.filter(id => ids.has(id)), ...tabs.map(tab => tab.id).filter(id => !this.order.includes(id))];
    const current = this.current.snapshot(), identity = `${this.localActive}:${current.active}:${current.surfaceEpoch}`;
    if (this.displayIdentity !== identity) { this.displayIdentity = identity; this.epoch++; }
    this.revision++; this.changed(this.snapshot());
  }
  snapshot(): TaskBrowserState {
    const machine = this.machine.snapshot(), local = this.local.snapshot(), current = this.current.snapshot();
    const tabs = [...machine.tabs.map(tab => ({ ...tab, execution: 'remote' as const })), ...local.tabs];
    const indices = new Map(this.order.map((id, index) => [id, index]));
    tabs.sort((a, b) => (indices.get(a.id) ?? this.order.length) - (indices.get(b.id) ?? this.order.length));
    return { ...current, tabs, ports: machine.ports, revision: this.revision, surfaceEpoch: this.epoch, canCreateLocalTabs: true, canReorder: true, agentRequests: machine.agentRequests };
  }
  private activate(local: boolean): void {
    if (this.localActive === local) return;
    this.current.hide(); this.localActive = local; this.current.hide(); this.update();
  }
  async command(input: TaskBrowserCommand): Promise<TaskBrowserState> {
    if (this.closed) throw new Error('Browser task closed');
    if (input.kind === 'move-tab') {
      this.owner(input.tabId); if (input.beforeTabId !== null) this.owner(input.beforeTabId);
      if (input.tabId !== input.beforeTabId) {
        this.order = this.order.filter(id => id !== input.tabId);
        this.order.splice(input.beforeTabId === null ? this.order.length : this.order.indexOf(input.beforeTabId), 0, input.tabId);
        this.update();
      }
      return this.snapshot();
    }
    let owner = 'tabId' in input ? this.owner(input.tabId) : input.kind.startsWith('agent-request-') || input.kind === 'open' ? this.machine : this.current;
    if (input.kind === 'new-tab') {
      if (this.snapshot().tabs.length >= 12) throw new Error('Close a tab before opening another.');
      owner = input.location === 'local' ? this.local : this.machine;
    }
    // Location is desktop-only intent; strict older remote hosts receive their original contract.
    const command = input.kind === 'new-tab' ? { kind: 'new-tab' as const } : input;
    const previous = this.localActive;
    const selects = input.kind === 'new-tab' || input.kind === 'select' || input.kind === 'open' || input.kind === 'agent-request-pick';
    const selection = selects ? ++this.selection : this.selection;
    if (selects) this.activate(owner === this.local);
    try { await owner.command(command); }
    catch (error) { if (selects && selection === this.selection && !this.closed) this.activate(previous); throw error; }
    if (this.closed) throw new Error('Browser task closed');
    if (selection === this.selection && !this.current.snapshot().tabs.length) this.activate(!this.localActive);
    this.update(); return this.snapshot();
  }
  surfaces(): readonly TaskBrowserSurface[] { return [...this.machine.surfaces(), ...this.local.surfaces()]; }
  position(input: TaskBrowserLayout): void {
    if (input.surfaceEpoch !== this.epoch) return;
    this.current.position({ ...input, surfaceEpoch: this.current.snapshot().surfaceEpoch });
  }
  presentation(tabId: string, value: 'embedded' | 'stream'): void { this.owner(tabId).presentation(tabId, value); }
  userInput(tabId: string, generation: number, input: TaskBrowserStreamInput): Promise<number> { return this.owner(tabId).userInput(tabId, generation, input); }
  acknowledge(tabId: string, streamId: string, sequence: number, decoded?: boolean): void { this.owner(tabId).acknowledge(tabId, streamId, sequence, decoded); }
  applicationInput(x?: number, y?: number): void { this.current.applicationInput(x, y); }
  maintain(): void { this.machine.maintain(); this.local.maintain(); }
  hide(): void { this.machine.hide(); this.local.hide(); }
  suspend(): void { this.machine.suspend(); this.local.suspend(); }
  revoke(): void { this.machine.revoke(); this.local.revoke(); }
  hasDetached(): boolean { return this.machine.hasDetached() || this.local.hasDetached(); }
  detachTab(tabId: string, window: BrowserWindow): void { this.owner(tabId).detachTab(tabId, window); }
  returnTab(tabId: string): void {
    if (!this.closed && this.snapshot().tabs.some(tab => tab.id === tabId)) this.owner(tabId).returnTab(tabId);
  }
  positionDetached(tabId: string, input: TaskBrowserLayout): void { this.owner(tabId).positionDetached(tabId, input); }
  hideDetached(tabId: string): void { if (!this.closed && this.snapshot().tabs.some(tab => tab.id === tabId)) this.owner(tabId).hideDetached(tabId); }
  applicationInputDetached(tabId: string, x?: number, y?: number): void { this.owner(tabId).applicationInputDetached(tabId, x, y); }
  detachedSurfaces(tabId: string): readonly TaskBrowserSurface[] { return this.owner(tabId).detachedSurfaces(tabId); }
  detachedSnapshot(tabId: string, state = this.snapshot()): TaskBrowserState {
    const owner = this.owner(tabId), view = owner.detachedSnapshot(tabId);
    return { ...state, ...view, tabs: state.tabs, revision: state.revision, active: tabId };
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true; this.machine.destroy(); this.local.destroy();
  }
}
