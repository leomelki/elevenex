import { DetachedBrowserWindows } from './detached-windows';
import { hardenTaskGuest } from './guest-policy';
import { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import type { BackendResult, TaskBrowserState, TaskBrowserPlacement } from '@elevenex/shared';
import type { BackendClient } from '../backend-client/client';
import { requestBackendJson } from '../backend-client/transport';
import type { RemoteManager } from '../remote/manager';
import { handleForWindow, sendToWindow, type TrustedSender } from '../ipc';
import { RemoteTaskBrowser } from './remote-task';
import { TaskBrowser } from './task';
import { BrowserTaskProfiles } from './task-session';
import { BrowserPersistence } from './persistence';
import { browserId, command, layout, record, taskId, streamInput, windowContext } from './validation';
import { BrowserAutomation } from './automation';
import { WebAuthnBroker } from './webauthn-broker';
import type { BrowserHost as BrowserTask, DesktopBrowserHost } from './host';
interface WindowBrowsers { readonly placements: Map<string, TaskBrowserPlacement>; readonly tasks: Map<string, BrowserTask>; readonly opening: Map<string, Promise<BrowserTask>>; readonly automation: Map<DesktopBrowserHost, BrowserAutomation>; readonly attaching: Set<string>; surfaceSnapshot: string; readonly guests: Map<number, { contents: Electron.WebContents; timer: ReturnType<typeof setTimeout> }>; cleanup(): void; selection: number; requested?: string; selected?: BrowserTask }

export function registerTaskBrowser(client: BackendClient, remote: RemoteManager, root: string, trusted: TrustedSender, createBrowserWindow: () => BrowserWindow = () => { throw new Error('Browser windows are unavailable'); }) {
  const windows = new Map<number, WindowBrowsers>();
  const detached = new DetachedBrowserWindows(createBrowserWindow, (id, scope) => client.state(id).scope?.id === scope);
  const persistence = new BrowserPersistence(root);
  const profiles = new BrowserTaskProfiles();
  const authenticator = new WebAuthnBroker();
  const availablePlacements = (id: number): readonly TaskBrowserPlacement[] => client.state(id).scope?.environment.kind === 'remote' ? ['desktop', 'desktop-proxy', 'machine'] : ['desktop'];
  const surfaces = (id: number) => detached.get(id) ? detached.surfaces(id) : [...(windows.get(id)?.tasks.values() ?? [])].flatMap(task => task.surfaces());
  const publishSurfaces = (id: number) => { const current = surfaces(id); const claims = windows.get(id)?.attaching; if (claims) for (const bootstrap of claims) if (!current.some(surface => surface.bootstrap === bootstrap)) claims.delete(bootstrap); const owner=windows.get(id),signature=JSON.stringify(current);if(owner&&owner.surfaceSnapshot!==signature){owner.surfaceSnapshot=signature;sendToWindow(id, 'task-browser:surfaces-changed', current);} };
  const windowOwner = (id: number) => {
    let owner = windows.get(id);
    if (!owner) {
      const window = BrowserWindow.fromWebContents(BrowserWindow.getAllWindows().find(item => item.webContents.id === id)!.webContents);
      if (!window) throw new Error('Browser window closed');
      const contents = window.webContents;
      owner = { placements: new Map(), surfaceSnapshot: '', guests: new Map(), attaching: new Set(), tasks: new Map(), opening: new Map(), automation: new Map(), selection: 0, cleanup: () => detach() }; windows.set(id, owner);
      const hide = () => { windows.get(id)?.selected?.hide(); };
      const detach = () => {
        const entry = windows.get(id); if (!entry) return;
        for (const automation of entry.automation.values()) automation.dispose(); entry.automation.clear(); for (const guest of entry.guests.values()) { clearTimeout(guest.timer); if (!guest.contents.isDestroyed()) guest.contents.close({ waitForBeforeUnload: false }); } entry.guests.clear(); for (const task of entry.tasks.values()) task.destroy(); windows.delete(id);
        window.removeListener('closed', detach); window.removeListener('minimize', hide); window.removeListener('hide', hide);
        contents.removeListener('did-start-navigation', navigation);
        contents.removeListener('render-process-gone', detach);
        contents.removeListener('will-attach-webview', attach);
        contents.removeListener('did-attach-webview', attached);
        contents.removeListener('before-mouse-event', mouse);contents.removeListener('before-input-event', key);
      };
      const navigation = (_event: Electron.Event, _url: string, inPlace: boolean, main: boolean) => { if (main && !inPlace) detach(); };
      const attach = (event: Electron.Event, preferences: Electron.WebPreferences, params: Record<string, string>) => {
        const expected = surfaces(id).find(surface => surface.partition === params['partition'] && surface.bootstrap === params['src']);
        // The app can only instantiate main-issued task guests. Never accept a page
        // URL, preload, unissued partition, or renderer-selected privileges.
        if (!expected || owner!.attaching.has(expected.bootstrap) || !trusted(window.webContents.mainFrame, window.webContents) ||
          [...owner!.tasks.values()].filter((task): task is DesktopBrowserHost => task.engine === 'desktop').some(task => task.hasContents(expected.tabId)) ||
          !hardenTaskGuest(preferences, params, expected.partition, expected.bootstrap)) { event.preventDefault(); return; }
        owner!.attaching.add(expected.bootstrap);

      };
      const attached = (_event: Electron.Event, contents: Electron.WebContents) => {
        if (owner!.guests.size >= 48) { contents.close({ waitForBeforeUnload: false }); return; }
        const timer = setTimeout(() => { owner!.guests.delete(contents.id); if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false }); }, 5000);
        owner!.guests.set(contents.id, { contents, timer });
        contents.once('destroyed', () => { clearTimeout(timer); owner!.guests.delete(contents.id); });
      };
      const mouse=(_event:Electron.Event,input:Electron.MouseInputEvent)=>{if(input.type==='mouseDown')owner!.selected?.applicationInput(input.x/window.webContents.getZoomFactor(),input.y/window.webContents.getZoomFactor());};
      // Streamed page keys arrive in the app's textarea. Modifier keys there are
      // page input; actual app overlays gate input through the measured layout.
      const key=(_event:Electron.Event,input:Electron.Input)=>{if(input.type==='keyDown'&&(input.control||input.meta||input.alt)&&owner!.selected?.engine==='desktop')owner!.selected.applicationInput();};
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
  const get = async (id: number, scope: string, task: number, replacement?: TaskBrowserPlacement): Promise<BrowserTask> => {
    const owner = windowOwner(id), key = scope + ':' + task;
    const selection = ++owner.selection; owner.requested = key;
    const current = client.state(id).scope;
    if (current?.id !== scope) throw new Error('Stale browser scope');
    for (const [identity, existing] of owner.tasks) if (existing.scopeId !== scope || existing.closed) { existing.destroy(); owner.tasks.delete(identity); owner.placements.delete(identity); }
    let browser = replacement ? undefined : owner.tasks.get(key);
    if (!browser) {
      let pending = owner.opening.get(key);
      if (!pending) {
        pending = (async () => {
          const original = owner.tasks.get(key);
          const originalTabs = original?.snapshot().tabs.map(tab => [tab.id, tab.generation]);
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
          const placement = replacement ?? owner.placements.get(key) ?? (environment.kind === 'remote' ? 'machine' : 'desktop');
          const onState = (state: TaskBrowserState) => { if (owner.tasks.get(key) !== created) return; const value = { ...state, placement, availablePlacements: availablePlacements(id) }; sendToWindow(id, 'task-browser:changed', value); detached.publish(created, value); };
          const onFrame = (frame: import('@elevenex/shared').TaskBrowserFrame) => { if (!detached.frame(created, frame)) sendToWindow(id, 'task-browser:frame', frame); };
          // Local pages always embed natively; only a remote private host streams.
          const created: BrowserTask = placement === 'machine' && environment.kind === 'remote'
            ? new RemoteTaskBrowser(scope, task, window, client, onState, () => owner.selected === created || detached.has(created), () => publishSurfaces(id), onFrame, remote, environment.kind === 'remote', authenticator)
            : new TaskBrowser(scope, task, window, client, remote, persistence, placement === 'desktop' ? identity : identity + ':' + placement, profiles, placement === 'desktop-proxy' && environment.kind === 'remote', onState, () => owner.selected === created || detached.has(created), () => publishSurfaces(id), onFrame, Number(reply.value['applicationPort']));
          if (created.engine === 'desktop') created.setPorts(reply.value.ports);
          let evict: [string, BrowserTask] | undefined;
          try {
            await created.restore();
            if (windows.get(id) !== owner || client.state(id).scope?.id !== scope || (replacement && selection !== owner.selection)) throw new Error('Browser selection changed');
            if (replacement && (owner.tasks.get(key) !== original || original?.hasDetached() || original?.snapshot().tabs.some(tab => tab.url || tab.loading) || JSON.stringify(original?.snapshot().tabs.map(tab => [tab.id, tab.generation])) !== JSON.stringify(originalTabs))) throw new Error('Browser changed while preparing its new location. Close loaded tabs and try again.');
            if (!owner.tasks.has(key) && owner.tasks.size >= 4) {
              evict = [...owner.tasks].find(([, item]) => item !== owner.selected && !detached.has(item));
              if (!evict) throw new Error('Close a task browser window before opening another task browser.');
            }
          } catch (error) { created.destroy(); throw error; }
          const previous = owner.tasks.get(key);
          if (previous && previous !== created) {
            if (previous.engine === 'desktop') { owner.automation.get(previous)?.dispose(); owner.automation.delete(previous); }
            previous.destroy();
          }
          if (evict) { evict[1].destroy(); owner.tasks.delete(evict[0]); owner.placements.delete(evict[0]); }
          owner.tasks.set(key, created);
          if (replacement) owner.placements.set(key, replacement);
          return created;
        })().finally(() => owner.opening.delete(key));
        owner.opening.set(key, pending);
      }
      browser = await pending;
    }
    if (windows.get(id) !== owner || selection !== owner.selection || client.state(id).scope?.id !== scope) throw new Error('Task selection changed');
    for (const other of owner.tasks.values()) if (other !== browser) other.hide();
    if (owner.selected && owner.selected !== browser) owner.selected.suspend();
    if (owner.selected?.engine === 'desktop' && owner.selected !== browser && !detached.has(owner.selected)) owner.automation.get(owner.selected)?.deactivate(owner.selected);
    owner.selected = browser;
    if (browser.engine === 'desktop') {
      let automation = owner.automation.get(browser);
      if (!automation) { automation = new BrowserAutomation(id, client); owner.automation.set(browser, automation); }
      automation.select(browser);
    }
    for (const [task, automation] of owner.automation) if (task.closed) { automation.dispose(); owner.automation.delete(task); }
    return browser;
  };
  const result = async (operation: () => Promise<TaskBrowserState>): Promise<BackendResult<TaskBrowserState>> => {
    try { return { ok: true, value: await operation() }; }
    catch (error) { return { ok: false, error: { code: 'unavailable', message: error instanceof Error ? error.message.slice(0, 240) : 'Task browser unavailable' } }; }
  };
  const selectedBrowser = (id: number, scope: string, task: number) => {
    if (detached.get(id, scope, task)) return detached.require(id).browser;
    const owner = windows.get(id), browser = owner?.tasks.get(scope + ':' + task);
    if (!browser || owner?.selected !== browser || client.state(id).scope?.id !== scope) throw new Error('Browser scope changed');
    return browser;
  };
  const ownerPlacement = (id: number, scope: string, task: number): TaskBrowserPlacement => windows.get(id)?.placements.get(scope + ':' + task) ?? (client.state(id).scope?.environment.kind === 'remote' ? 'machine' : 'desktop');
  const stops = [
    handleForWindow('task-browser:configure', trusted, (id, ...args) => {
      const placement = args[2];
      if (args.length !== 3 || detached.get(id) || (placement !== 'desktop' && placement !== 'desktop-proxy' && placement !== 'machine')) throw new Error('Invalid browser placement');
      const scope = browserId(args[0]), task = taskId(args[1]);
      return result(async () => {
        const browser = selectedBrowser(id, scope, task), owner = windows.get(id)!;
        if (browser.hasDetached() || browser.snapshot().tabs.some(tab => tab.url || tab.loading)) throw new Error('Close tabs with loaded pages before changing where the browser runs.');
        const previousPlacement = ownerPlacement(id, scope, task), key = scope + ':' + task;
        if (previousPlacement === placement) return { ...browser.snapshot(), placement, availablePlacements: availablePlacements(id) };
        if (owner.opening.has(key)) throw new Error('Browser placement is already changing.');
        // Prepare first, then recheck ownership and empty tabs before replacement.
        const next = await get(id, scope, task, placement);
        return { ...next.snapshot(), placement, availablePlacements: availablePlacements(id) };
      });
    }),
    handleForWindow('task-browser:detach', trusted, (id, ...args) => {
      if (args.length !== 4 || detached.get(id)) throw new Error('Invalid detached tab request');
      const browser = selectedBrowser(id, browserId(args[0]), taskId(args[1]));
      detached.open(id, browser, browserId(args[2]), windowContext(args[3]));
    }),
    handleForWindow('task-browser:return', trusted, (id, ...args) => {
      if (args.length !== 3 || detached.get(id)) throw new Error('Invalid return request');
      detached.returnFrom(id, selectedBrowser(id, browserId(args[0]), taskId(args[1])), browserId(args[2]));
    }),
    handleForWindow('task-browser:window', trusted, (id, ...args) => {
      if (args.length) throw new Error('Invalid window request');
      return detached.get(id)?.info ?? null;
    }),
    handleForWindow('task-browser:window-action', trusted, (id, ...args) => {
      if (args.length !== 1 || (args[0] !== 'return' && args[0] !== 'reveal')) throw new Error('Invalid window action');
      const entry = detached.require(id);
      if (args[0] === 'return') detached.return(entry); else detached.reveal(entry);
    }),
    handleForWindow('task-browser:attach', trusted, (id, ...args) => {
      if (args.length !== 4 || !Number.isSafeInteger(args[3]) || args[3] < 1) throw new Error('Invalid browser attachment');
      const scope = browserId(args[0]), task = taskId(args[1]), tab = browserId(args[2]), owner = windows.get(id), guest = owner?.guests.get(args[3]);
      const entry = detached.get(id, scope, task), browser = entry ? detached.require(id).browser : owner?.tasks.get(scope + ':' + task);
      const bootstrap = guest?.contents.getURL();
      if (!owner || !guest || !browser || (!entry && client.state(id).scope?.id !== scope) || (entry && entry.info.tabId !== tab) || !surfaces(id).some(surface => surface.tabId === tab && surface.bootstrap === bootstrap) || browser.engine !== 'desktop' || !browser.attach(guest.contents, tab)) {
        if (guest && !guest.contents.isDestroyed()) guest.contents.close({ waitForBeforeUnload: false });
        throw new Error('Browser attachment changed');
      }
      clearTimeout(guest.timer); owner.guests.delete(args[3]); if (bootstrap) owner.attaching.delete(bootstrap);
    }),
    handleForWindow('task-browser:surfaces', trusted, (id, ...args) => { if (args.length) throw new Error('Invalid surface request'); windowOwner(id); return surfaces(id); }),
    handleForWindow('task-browser:presentation', trusted, (id, ...args) => {
      if (args.length !== 4 || (args[3] !== 'embedded' && args[3] !== 'stream')) throw new Error('Invalid browser presentation');
      if (detached.get(id)) throw new Error('Return this tab before changing its display');
      selectedBrowser(id, browserId(args[0]), taskId(args[1])).presentation(browserId(args[2]), args[3]);
    }),
    handleForWindow('task-browser:frame-ack', trusted, (id, ...args) => {
      if ((args.length !== 5 && args.length !== 6) || (args.length === 6 && typeof args[5] !== 'boolean') || !Number.isSafeInteger(args[4]) || args[4] < 1) throw new Error('Invalid frame receipt');
      const tab = browserId(args[2]), entry = detached.get(id); if (entry && entry.info.tabId !== tab) throw new Error('Browser tab changed');
      selectedBrowser(id, browserId(args[0]), taskId(args[1])).acknowledge(tab, browserId(args[3]), args[4], args[5]);
    }),
    handleForWindow('task-browser:input', trusted, (id, ...args) => {
      if (args.length !== 5 || !Number.isSafeInteger(args[3]) || args[3] < 1) throw new Error('Invalid browser control');
      const tab = browserId(args[2]), entry = detached.get(id); if (entry && entry.info.tabId !== tab) throw new Error('Browser tab changed');
      return selectedBrowser(id, browserId(args[0]), taskId(args[1])).userInput(tab, args[3], streamInput(args[4]));
    }),
    handleForWindow('task-browser:read', trusted, (id, ...args) => {
      if (args.length !== 2) throw new Error('Invalid browser read');
      const scope = browserId(args[0]), task = taskId(args[1]);
      return result(async () => { const entry = detached.get(id, scope, task); if (entry) { detached.require(id); return detached.snapshot(entry); } const browser=await get(id, scope, task);if(browser.engine === 'machine')await browser.refresh();return { ...browser.snapshot(), placement: ownerPlacement(id, scope, task), availablePlacements: availablePlacements(id) };});
    }),
    handleForWindow('task-browser:command', trusted, (id, ...args) => {
      if (args.length !== 3) throw new Error('Invalid browser command');
      const scope = browserId(args[0]), task = taskId(args[1]), input = command(args[2]);
      return result(async () => {
        const entry = detached.get(id, scope, task);
        if (entry) { detached.require(id); detached.command(entry, input); await entry.browser.command(input); return detached.snapshot(entry); }
        const owner = windows.get(id), browser = owner?.tasks.get(scope + ':' + task);
        if (!browser || owner?.selected !== browser || client.state(id).scope?.id !== scope) throw new Error('Task selection changed. Reopen its Browser.');
        return { ...await browser.command(input), placement: ownerPlacement(id, scope, task), availablePlacements: availablePlacements(id) };
      });
    }),
    handleForWindow('task-browser:layout', trusted, (id, ...args) => {
      if (args.length !== 3) throw new Error('Invalid browser layout');
      const scope = browserId(args[0]), task = taskId(args[1]), input = layout(args[2]);
      const entry = detached.get(id, scope, task);
      if (entry) { detached.require(id).browser.positionDetached(entry.info.tabId, input); return; }
      if (client.state(id).scope?.id !== scope) return;
      const owner = windows.get(id), browser = owner?.tasks.get(scope + ':' + task);
      if (browser && owner?.selected === browser) browser.position(input);
    }),
    handleForWindow('task-browser:deactivate', trusted, (id, ...args) => {
      if (args.length !== 2) throw new Error('Invalid browser deactivation');
      const scope = browserId(args[0]), task = taskId(args[1]), owner = windows.get(id);
      const entry = detached.get(id, scope, task); if (entry) { entry.browser.hideDetached(entry.info.tabId); return; }
      if (!owner) return;
      if (owner.requested === scope + ':' + task) { owner.selection++; owner.requested = undefined; }
      const selected = owner.selected;
      if (!selected || selected.scopeId !== scope || selected.taskId !== task) return;
      if (selected.engine === 'desktop' && !detached.has(selected)) owner.automation.get(selected)?.deactivate(selected); else selected.suspend(); owner.selected = undefined;
    }),
    handleForWindow('task-browser:hide', trusted, (id, ...args) => {
      if (args.length !== 2) throw new Error('Invalid browser hide');
      const scope = browserId(args[0]), task = taskId(args[1]);
      const entry = detached.get(id, scope, task); if (entry) { entry.browser.hideDetached(entry.info.tabId); return; }
      const selected = windows.get(id)?.selected;
      if (selected?.scopeId === scope && selected.taskId === task) selected.hide();
    }),
  ];
  const timer = setInterval(() => { for (const owner of windows.values()) for (const task of owner.tasks.values()) { task.maintain(); if (task !== owner.selected && !detached.has(task)) { if (task.engine === 'desktop') owner.automation.get(task)?.deactivate(task); } } detached.maintain(); }, 250);
  return { permitsPointerLock(id: number) { return surfaces(id).some(surface => surface.presentation === 'stream' && surface.visible && surface.interactive && surface.driver !== 'agent' && surface.pointerLocked); }, permitsGuest(id: number, params: Record<string, string>) { return surfaces(id).some(surface => surface.partition === params['partition'] && surface.bootstrap === params['src']); }, dispose() { clearInterval(timer); authenticator.dispose(); detached.dispose(); for (const stop of stops) stop(); for (const owner of [...windows.values()]) owner.cleanup(); windows.clear(); }, flush: () => Promise.all([persistence.flush(), profiles.flush()]) };
}
