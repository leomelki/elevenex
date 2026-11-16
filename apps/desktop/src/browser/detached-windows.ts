import { BrowserWindow } from 'electron';
import type { TaskBrowserCommand, TaskBrowserFrame, TaskBrowserState, TaskBrowserSurface, TaskBrowserWindowContext, TaskBrowserWindowInfo } from '@elevenex/shared';
import { sendToWindow } from '../ipc';
import type { BrowserHost as BrowserTask } from './host';
interface DetachedTab {
  readonly sourceId: number;
  readonly browser: BrowserTask;
  readonly window: BrowserWindow;
  info: TaskBrowserWindowInfo;
  cleanup(): void;
}

/** Owns companion windows; task/page resources remain with their original workspace. */
export class DetachedBrowserWindows {
  private readonly tabs = new Map<number, DetachedTab>();
  constructor(private readonly createWindow: () => BrowserWindow, private readonly valid: (sourceId: number, scopeId: string) => boolean) {}
  get(id: number, scope?: string, task?: number): DetachedTab | undefined {
    const entry = this.tabs.get(id);
    if (entry && (scope !== undefined && scope !== entry.info.scopeId || task !== undefined && task !== entry.info.taskId)) throw new Error('Detached browser scope changed');
    return entry;
  }
  require(id: number): DetachedTab {
    const entry = this.tabs.get(id);
    if (!entry || !entry.info.available || entry.browser.closed || !this.valid(entry.sourceId, entry.info.scopeId)) throw new Error('The task window is unavailable');
    return entry;
  }
  has(browser: BrowserTask): boolean { return [...this.tabs.values()].some(entry => entry.browser === browser && entry.info.available); }
  open(sourceId: number, browser: BrowserTask, tabId: string, context: TaskBrowserWindowContext): void {
    const existing = [...this.tabs.values()].find(entry => entry.sourceId === sourceId && entry.browser === browser && entry.info.tabId === tabId && entry.info.available);
    if (existing) { this.focus(existing.window); return; }
    if (!browser.snapshot().tabs.some(tab => tab.id === tabId)) throw new Error('Browser tab closed');
    if (this.tabs.size >= 12) throw new Error('Close a browser window before opening another.');
    const window = this.createWindow(), contents = window.webContents, id = contents.id;
    const hide = () => browser.hideDetached(tabId);
    const mouse = (_event: Electron.Event, input: Electron.MouseInputEvent) => { if (input.type === 'mouseDown') browser.applicationInputDetached(tabId, input.x / window.webContents.getZoomFactor(), input.y / window.webContents.getZoomFactor()); };
    const key = (_event: Electron.Event, input: Electron.Input) => { if ((browser.engine === 'desktop' || browser.snapshot().tabs.some(tab => tab.id === tabId && tab.execution === 'local')) && input.type === 'keyDown' && (input.control || input.meta || input.alt)) browser.applicationInputDetached(tabId); };
    const navigation = (_event: Electron.Event, _url: string, inPlace: boolean, main: boolean) => { if (main && !inPlace) hide(); };
    const closed = () => {
      this.tabs.delete(id); browser.returnTab(tabId); cleanup();
    };
    const cleanup = () => {
      window.removeListener('closed', closed); window.removeListener('minimize', hide); window.removeListener('hide', hide);
      contents.removeListener('before-mouse-event', mouse); contents.removeListener('before-input-event', key);
      contents.removeListener('did-start-navigation', navigation); contents.removeListener('render-process-gone', hide);
    };
    const entry: DetachedTab = { sourceId, browser, window, info: { scopeId: browser.scopeId, taskId: browser.taskId, tabId, context, available: true }, cleanup };
    this.tabs.set(id, entry);
    try { browser.detachTab(tabId, window); }
    catch (error) { this.tabs.delete(id); window.destroy(); throw error; }
    window.on('closed', closed); window.on('minimize', hide); window.on('hide', hide);
    window.webContents.on('before-mouse-event', mouse); window.webContents.on('before-input-event', key);
    window.webContents.on('did-start-navigation', navigation); window.webContents.on('render-process-gone', hide);
    this.publish(browser, browser.snapshot());
  }
  private focus(window: BrowserWindow): void { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  reveal(entry: DetachedTab): void {
    if (!entry.info.available || !this.valid(entry.sourceId, entry.info.scopeId)) throw new Error('The task window is unavailable');
    sendToWindow(entry.sourceId, 'task-browser:reveal-task', { scopeId: entry.info.scopeId, taskId: entry.info.taskId });
    // Resolve by live webContents identity, never a persisted checkout or UI focus.
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.id === entry.sourceId);
    if (window) this.focus(window);
  }
  return(entry: DetachedTab, reveal = true): void {
    if (reveal) this.reveal(entry);
    entry.browser.returnTab(entry.info.tabId);
    if (reveal) void entry.browser.command({ kind: 'select', tabId: entry.info.tabId }).catch(() => undefined);
    // Reply to the typed invoke before disposing its calling renderer frame.
    const close = setTimeout(() => { if (!entry.window.isDestroyed()) entry.window.close(); }, 0);
    entry.window.once('closed', () => clearTimeout(close));
  }
  returnFrom(sourceId: number, browser: BrowserTask, tabId: string): void {
    const entry = [...this.tabs.values()].find(entry => entry.sourceId === sourceId && entry.browser === browser && entry.info.tabId === tabId);
    if (entry) this.return(entry, false);
  }
  snapshot(entry: DetachedTab, state = entry.browser.snapshot()): TaskBrowserState {
    const view = entry.browser.detachedSnapshot(entry.info.tabId, state);
    const ownsPicker = view.active === entry.info.tabId;
    return { ...view, canReorder: false, picked: ownsPicker ? view.picked : null, picking: ownsPicker && view.picking, pickerMessage: ownsPicker ? view.pickerMessage : null, attention: !view.attention?.tabId || view.attention.tabId === entry.info.tabId ? view.attention : undefined, tabs: view.tabs.filter(tab => tab.id === entry.info.tabId).map(tab => ({ ...tab, detached: false })), active: entry.info.tabId };
  }
  command(entry: DetachedTab, input: TaskBrowserCommand): void {
    if (input.kind === 'dismiss-attention') {
      const attention = entry.browser.snapshot().attention;
      // A companion may dismiss only the notice it can currently display.
      if (!attention?.tabId || attention.tabId === entry.info.tabId) return;
      throw new Error('This notice belongs to another browser tab');
    }
    if (!('tabId' in input) || input.tabId !== entry.info.tabId || input.kind === 'select' || input.kind === 'close' || input.kind === 'move-tab') throw new Error('This window controls only its own tab');
  }
  surfaces(id: number): readonly TaskBrowserSurface[] { const entry = this.tabs.get(id); return entry?.info.available ? entry.browser.detachedSurfaces(entry.info.tabId) : []; }
  publish(browser: BrowserTask, state: TaskBrowserState): void {
    for (const [id, entry] of this.tabs) if (entry.browser === browser && entry.info.available) {
      if (!state.tabs.some(tab => tab.id === entry.info.tabId)) { entry.window.close(); continue; }
      const tab = state.tabs.find(tab => tab.id === entry.info.tabId);
      entry.window.setTitle(`${tab?.driver === 'needs' ? 'Your turn · ' : ''}${tab?.title || 'Browser'} — ${entry.info.context.taskName}`);
      sendToWindow(id, 'task-browser:changed', this.snapshot(entry, state));
      sendToWindow(id, 'task-browser:surfaces-changed', this.surfaces(id));
    }
  }
  frame(browser: BrowserTask, frame: TaskBrowserFrame): boolean {
    const entry = [...this.tabs.values()].find(entry => entry.browser === browser && entry.info.tabId === frame.tabId && entry.info.available);
    if (!entry) return false;
    sendToWindow(entry.window.webContents.id, 'task-browser:frame', frame); return true;
  }
  maintain(): void {
    for (const [id, entry] of this.tabs) if (entry.info.available && (entry.browser.closed || !this.valid(entry.sourceId, entry.info.scopeId))) {
      entry.browser.returnTab(entry.info.tabId); entry.info = { ...entry.info, available: false };
      sendToWindow(id, 'task-browser:window-changed', entry.info); sendToWindow(id, 'task-browser:surfaces-changed', []);
    }
  }
  dispose(): void { for (const entry of [...this.tabs.values()]) { entry.cleanup(); entry.window.destroy(); } this.tabs.clear(); }
}
