import { hardenTaskGuest } from './guest-policy';
import { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import type { BackendResult, TaskBrowserState } from '@elevenex/shared';
import type { BackendClient } from '../backend-client/client';
import { requestBackendJson } from '../backend-client/transport';
import type { RemoteManager } from '../remote/manager';
import { handleForWindow, sendToWindow, type TrustedSender } from '../ipc';
import { RemoteTaskBrowser } from './remote-task';
import { TaskBrowser } from './task';
import { BrowserPersistence } from './persistence';
import { browserId, command, layout, record, taskId, streamInput } from './validation';
import { BrowserAutomation } from './automation';
type BrowserTask = TaskBrowser | RemoteTaskBrowser;
interface WindowBrowsers { readonly tasks: Map<string, BrowserTask>; readonly opening: Map<string, Promise<BrowserTask>>; readonly automation: BrowserAutomation; readonly attaching: Set<string>; surfaceSnapshot: string; readonly guests: Map<number, { contents: Electron.WebContents; timer: ReturnType<typeof setTimeout> }>; cleanup(): void; selection: number; requested?: string; selected?: BrowserTask }

export function registerTaskBrowser(client: BackendClient, remote: RemoteManager, root: string, trusted: TrustedSender) {
  const windows = new Map<number, WindowBrowsers>();
  const persistence = new BrowserPersistence(root);
  const surfaces = (id: number) => [...(windows.get(id)?.tasks.values() ?? [])].flatMap(task => task.surfaces());
  const publishSurfaces = (id: number) => { const current = surfaces(id); const claims = windows.get(id)?.attaching; if (claims) for (const partition of claims) if (!current.some(surface => surface.tabId === partition)) claims.delete(partition); const owner=windows.get(id),signature=JSON.stringify(current);if(owner&&owner.surfaceSnapshot!==signature){owner.surfaceSnapshot=signature;sendToWindow(id, 'task-browser:surfaces-changed', current);} };
  const windowOwner = (id: number) => {
    let owner = windows.get(id);
    if (!owner) {
      const window = BrowserWindow.fromWebContents(BrowserWindow.getAllWindows().find(item => item.webContents.id === id)!.webContents);
      if (!window) throw new Error('Browser window closed');
      owner = { surfaceSnapshot: '', guests: new Map(), attaching: new Set(), tasks: new Map(), opening: new Map(), automation: new BrowserAutomation(id, client), selection: 0, cleanup: () => detach() }; windows.set(id, owner);
      const hide = () => { windows.get(id)?.selected?.hide(); };
      const detach = () => {
        const entry = windows.get(id); if (!entry) return;
        entry.automation.dispose(); for (const guest of entry.guests.values()) { clearTimeout(guest.timer); if (!guest.contents.isDestroyed()) guest.contents.close({ waitForBeforeUnload: false }); } entry.guests.clear(); for (const task of entry.tasks.values()) task.destroy(); windows.delete(id);
        window.removeListener('closed', detach); window.removeListener('minimize', hide); window.removeListener('hide', hide);
        window.webContents.removeListener('did-start-navigation', navigation);
        window.webContents.removeListener('render-process-gone', detach);
        window.webContents.removeListener('will-attach-webview', attach);
        window.webContents.removeListener('did-attach-webview', attached);
        window.webContents.removeListener('before-mouse-event', mouse);window.webContents.removeListener('before-input-event', key);
      };
      const navigation = (_event: Electron.Event, _url: string, inPlace: boolean, main: boolean) => { if (main && !inPlace) detach(); };
      const attach = (event: Electron.Event, preferences: Electron.WebPreferences, params: Record<string, string>) => {
        const expected = surfaces(id).find(surface => surface.partition === params['partition'] && surface.bootstrap === params['src']);
        // The app can only instantiate main-issued task guests. Never accept a page
        // URL, preload, persistent/default partition, or renderer-selected privileges.
        if (!expected || owner!.attaching.has(expected.tabId) || !trusted(window.webContents.mainFrame, window.webContents) ||
          [...owner!.tasks.values()].filter((task): task is TaskBrowser => task instanceof TaskBrowser).some(task => [...task.pages.values()].some(page => page.id === expected.tabId && page.hasContents)) ||
          !hardenTaskGuest(preferences, params, expected.partition, expected.bootstrap)) { event.preventDefault(); return; }
        owner!.attaching.add(expected.tabId);

      };
      const attached = (_event: Electron.Event, contents: Electron.WebContents) => {
        if (owner!.guests.size >= 48) { contents.close({ waitForBeforeUnload: false }); return; }
        const timer = setTimeout(() => { owner!.guests.delete(contents.id); if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false }); }, 5000);
        owner!.guests.set(contents.id, { contents, timer });
        contents.once('destroyed', () => { clearTimeout(timer); owner!.guests.delete(contents.id); });
      };
      const mouse=(_event:Electron.Event,input:Electron.MouseInputEvent)=>{if(input.type==='mouseDown')owner!.selected?.applicationInput(input.x/window.webContents.getZoomFactor(),input.y/window.webContents.getZoomFactor());};
      const key=(_event:Electron.Event,input:Electron.Input)=>{if(input.type==='keyDown'&&(input.control||input.meta||input.alt))owner!.selected?.applicationInput();};
      window.webContents.on('before-mouse-event',mouse);window.webContents.on('before-input-event',key);
      window.once('closed', detach);
      window.webContents.on('did-start-navigation', navigation);
      window.webContents.on('render-process-gone', detach);
      window.webContents.on('will-attach-webview', attach);
      window.webContents.on('did-attach-webview', attached);
      window.on('minimize', hide); window.on('hide', hide);
    }
    return owner;
  };
  const get = async (id: number, scope: string, task: number): Promise<BrowserTask> => {
    const owner = windowOwner(id), key = scope + ':' + task;
    const selection = ++owner.selection; owner.requested = key;
    const current = client.state(id).scope;
    if (current?.id !== scope) throw new Error('Stale browser scope');
    for (const [identity, existing] of owner.tasks) if (existing.scopeId !== scope || existing.closed) { existing.destroy(); owner.tasks.delete(identity); }
    let browser = owner.tasks.get(key);
    if (!browser) {
      let pending = owner.opening.get(key);
      if (!pending) {
        pending = (async () => {
          const reply = await client.execute(id, scope, 'task-browser-task:' + task, false, async (endpoint, signal) => {
            const value = record(await requestBackendJson(endpoint, { path: '/api/desktop-browser/tasks/' + task }, signal));
            if (value['id'] !== task || value['state'] !== 'ready' || typeof value['identity'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['identity'])) throw new Error('Task is not available');
            taskId(value['repoId']);
            const ports: unknown = value['ports'] ?? [];
            if (!Array.isArray(ports) || ports.length > 32 || ports.some(port => typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid task servers');
            const parsed: Record<string, unknown> & { ports: readonly number[] } = { ...value, ports: ports.map(Number), applicationPort: Number(new URL(endpoint.url).port) };
            return parsed;
          });
          if (!reply.ok) throw new Error('Task browser is unavailable. Refresh the workspace.');
          if (windows.get(id) !== owner || client.state(id).scope?.id !== scope) throw new Error('Stale browser owner');
          const window = BrowserWindow.getAllWindows().find(item => item.webContents.id === id);
          if (!window) throw new Error('Window closed');
          const environment = current.environment;
          // Include the saved remote destination configuration so reused numeric IDs on
          // an edited SSH host cannot restore another backend's task navigation.
          const destination = remote.configurationIdentity(environment);
          const identity = createHash('sha256').update(JSON.stringify([destination, reply.value['repoId'], task, reply.value['identity']])).digest('hex');
          const onState = (state: TaskBrowserState) => sendToWindow(id, 'task-browser:changed', state);
          const onFrame = (frame: import('@elevenex/shared').TaskBrowserFrame) => sendToWindow(id, 'task-browser:frame', frame);
          const created: BrowserTask = environment.kind === 'remote'
            ? new RemoteTaskBrowser(scope, task, window, client, onState, () => owner.selected === created, () => publishSurfaces(id), onFrame, remote)
            : new TaskBrowser(scope, task, window, client, remote, persistence, identity, false, onState, () => owner.selected === created, () => publishSurfaces(id), onFrame, Number(reply.value['applicationPort']));
          if (created instanceof TaskBrowser) created.setPorts(reply.value.ports);
          try { await created.restore(); } catch (error) { created.destroy(); throw error; }
          owner.tasks.set(key, created);
          if (owner.tasks.size > 4) { const evict = [...owner.tasks].find(([, item]) => item !== created && item !== owner.selected); if (evict) { evict[1].destroy(); owner.tasks.delete(evict[0]); } }
          return created;
        })().finally(() => owner.opening.delete(key));
        owner.opening.set(key, pending);
      }
      browser = await pending;
    }
    if (windows.get(id) !== owner || selection !== owner.selection || client.state(id).scope?.id !== scope) throw new Error('Task selection changed');
    for (const other of owner.tasks.values()) if (other !== browser) other.hide();
    if (owner.selected && owner.selected !== browser) owner.selected.suspend();
    owner.selected = browser; if (browser instanceof TaskBrowser) owner.automation.select(browser);
    return browser;
  };
  const result = async (operation: () => Promise<TaskBrowserState>): Promise<BackendResult<TaskBrowserState>> => {
    try { return { ok: true, value: await operation() }; }
    catch (error) { return { ok: false, error: { code: 'unavailable', message: error instanceof Error ? error.message.slice(0, 240) : 'Task browser unavailable' } }; }
  };
  const selectedBrowser = (id: number, scope: string, task: number) => {
    const owner = windows.get(id), browser = owner?.tasks.get(scope + ':' + task);
    if (!browser || owner?.selected !== browser || client.state(id).scope?.id !== scope) throw new Error('Browser scope changed');
    return browser;
  };
  const stops = [
    handleForWindow('task-browser:attach', trusted, (id, ...args) => {
      if (args.length !== 4 || !Number.isSafeInteger(args[3]) || args[3] < 1) throw new Error('Invalid browser attachment');
      const scope = browserId(args[0]), task = taskId(args[1]), tab = browserId(args[2]), owner = windows.get(id), guest = owner?.guests.get(args[3]);
      const browser = owner?.tasks.get(scope + ':' + task);
      if (!owner || !guest || !browser || client.state(id).scope?.id !== scope || guest.contents.getURL() !== 'about:blank#' + tab || !(browser instanceof TaskBrowser) || !browser.attach(guest.contents, tab)) {
        if (guest && !guest.contents.isDestroyed()) guest.contents.close({ waitForBeforeUnload: false });
        throw new Error('Browser attachment changed');
      }
      clearTimeout(guest.timer); owner.guests.delete(args[3]); owner.attaching.delete(tab);
    }),
    handleForWindow('task-browser:surfaces', trusted, (id, ...args) => { if (args.length) throw new Error('Invalid surface request'); windowOwner(id); return surfaces(id); }),
    handleForWindow('task-browser:presentation', trusted, (id, ...args) => {
      if (args.length !== 4 || (args[3] !== 'embedded' && args[3] !== 'stream')) throw new Error('Invalid browser presentation');
      selectedBrowser(id, browserId(args[0]), taskId(args[1])).presentation(browserId(args[2]), args[3]);
    }),
    handleForWindow('task-browser:frame-ack', trusted, (id, ...args) => {
      if (args.length !== 5 || !Number.isSafeInteger(args[4]) || args[4] < 1) throw new Error('Invalid frame receipt');
      selectedBrowser(id, browserId(args[0]), taskId(args[1])).acknowledge(browserId(args[2]), browserId(args[3]), args[4]);
    }),
    handleForWindow('task-browser:input', trusted, (id, ...args) => {
      if (args.length !== 5 || !Number.isSafeInteger(args[3]) || args[3] < 1) throw new Error('Invalid browser control');
      return selectedBrowser(id, browserId(args[0]), taskId(args[1])).userInput(browserId(args[2]), args[3], streamInput(args[4]));
    }),
    handleForWindow('task-browser:read', trusted, (id, ...args) => {
      if (args.length !== 2) throw new Error('Invalid browser read');
      const scope = browserId(args[0]), task = taskId(args[1]);
      return result(async () => {const browser=await get(id, scope, task);if(browser instanceof RemoteTaskBrowser)await browser.refresh();return browser.snapshot();});
    }),
    handleForWindow('task-browser:command', trusted, (id, ...args) => {
      if (args.length !== 3) throw new Error('Invalid browser command');
      const scope = browserId(args[0]), task = taskId(args[1]), input = command(args[2]);
      return result(async () => {
        const owner = windows.get(id), browser = owner?.tasks.get(scope + ':' + task);
        if (!browser || owner?.selected !== browser || client.state(id).scope?.id !== scope) throw new Error('Task selection changed. Reopen its Browser.');
        return browser.command(input);
      });
    }),
    handleForWindow('task-browser:layout', trusted, (id, ...args) => {
      if (args.length !== 3) throw new Error('Invalid browser layout');
      const scope = browserId(args[0]), task = taskId(args[1]), input = layout(args[2]);
      if (client.state(id).scope?.id !== scope) return;
      const owner = windows.get(id), browser = owner?.tasks.get(scope + ':' + task);
      if (browser && owner?.selected === browser) browser.position(input);
    }),
    handleForWindow('task-browser:deactivate', trusted, (id, ...args) => {
      if (args.length !== 2) throw new Error('Invalid browser deactivation');
      const scope = browserId(args[0]), task = taskId(args[1]), owner = windows.get(id);
      if (!owner) return;
      if (owner.requested === scope + ':' + task) { owner.selection++; owner.requested = undefined; }
      const selected = owner.selected;
      if (!selected || selected.scopeId !== scope || selected.taskId !== task) return;
      if (selected instanceof TaskBrowser) owner.automation.deactivate(selected); else selected.suspend(); owner.selected = undefined;
    }),
    handleForWindow('task-browser:hide', trusted, (id, ...args) => {
      if (args.length !== 2) throw new Error('Invalid browser hide');
      const scope = browserId(args[0]), task = taskId(args[1]), selected = windows.get(id)?.selected;
      if (selected?.scopeId === scope && selected.taskId === task) selected.hide();
    }),
  ];
  const timer = setInterval(() => { for (const owner of windows.values()) for (const task of owner.tasks.values()) task.maintain(); }, 250);
  return { permitsGuest(id: number, params: Record<string, string>) { return surfaces(id).some(surface => surface.partition === params['partition'] && surface.bootstrap === params['src']); }, dispose() { clearInterval(timer); for (const stop of stops) stop(); for (const owner of [...windows.values()]) owner.cleanup(); windows.clear(); }, flush: () => persistence.flush() };
}
