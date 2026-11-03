import { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import type { BackendResult, TaskBrowserState } from '@elevenex/shared';
import type { BackendClient } from '../backend-client/client';
import { requestBackendJson } from '../backend-client/transport';
import type { RemoteManager } from '../remote/manager';
import { handleForWindow, sendToWindow, type TrustedSender } from '../ipc';
import { TaskBrowser } from './task';
import { BrowserPersistence } from './persistence';
import { browserId, command, layout, record, taskId } from './validation';
import { BrowserAutomation } from './automation';
interface WindowBrowsers { readonly tasks: Map<string, TaskBrowser>; readonly opening: Map<string, Promise<TaskBrowser>>; readonly automation: BrowserAutomation; cleanup(): void; selection: number; requested?: string; selected?: TaskBrowser }

export function registerTaskBrowser(client: BackendClient, remote: RemoteManager, root: string, trusted: TrustedSender) {
  const windows = new Map<number, WindowBrowsers>();
  const persistence = new BrowserPersistence(root);
  const windowOwner = (id: number) => {
    let owner = windows.get(id);
    if (!owner) {
      const window = BrowserWindow.fromWebContents(BrowserWindow.getAllWindows().find(item => item.webContents.id === id)!.webContents);
      if (!window) throw new Error('Browser window closed');
      owner = { tasks: new Map(), opening: new Map(), automation: new BrowserAutomation(id, client), selection: 0, cleanup: () => detach() }; windows.set(id, owner);
      const hide = () => { windows.get(id)?.selected?.hide(); };
      const detach = () => {
        const entry = windows.get(id); if (!entry) return;
        entry.automation.dispose(); for (const task of entry.tasks.values()) task.destroy(); windows.delete(id);
        window.removeListener('closed', detach); window.removeListener('minimize', hide); window.removeListener('hide', hide);
        window.webContents.removeListener('did-start-navigation', navigation);
        window.webContents.removeListener('render-process-gone', detach);
        window.webContents.removeListener('before-mouse-event', mouseInput);
        window.webContents.removeListener('before-input-event', keyInput);
      };
      const navigation = (_event: Electron.Event, _url: string, inPlace: boolean, main: boolean) => { if (main && !inPlace) detach(); };
      const mouseInput = (_event: Electron.Event, mouse: Electron.MouseInputEvent) => { if (mouse.type === 'mouseDown') hide(); };
      const keyInput = (_event: Electron.Event, input: Electron.Input) => { if (input.type === 'keyDown' && (input.control || input.meta || input.alt)) hide(); };
      window.once('closed', detach);
      window.webContents.on('did-start-navigation', navigation);
      window.webContents.on('render-process-gone', detach);
      // Hide before native app input can open an overlay above the page surface.
      window.webContents.on('before-mouse-event', mouseInput);
      window.webContents.on('before-input-event', keyInput);
      window.on('minimize', hide); window.on('hide', hide);
    }
    return owner;
  };
  const get = async (id: number, scope: string, task: number): Promise<TaskBrowser> => {
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
            const parsed: Record<string, unknown> & { ports: readonly number[] } = { ...value, ports: ports.map(Number) };
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
          const created: TaskBrowser = new TaskBrowser(scope, task, window, client, remote, persistence, identity, environment.kind === 'remote',
            state => sendToWindow(id, 'task-browser:changed', state), () => owner.selected === created);
          created.setPorts(reply.value.ports);
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
    owner.selected = browser; owner.automation.select(browser);
    return browser;
  };
  const result = async (operation: () => Promise<TaskBrowserState>): Promise<BackendResult<TaskBrowserState>> => {
    try { return { ok: true, value: await operation() }; }
    catch (error) { return { ok: false, error: { code: 'unavailable', message: error instanceof Error ? error.message.slice(0, 240) : 'Task browser unavailable' } }; }
  };
  const stops = [
    handleForWindow('task-browser:read', trusted, (id, ...args) => {
      if (args.length !== 2) throw new Error('Invalid browser read');
      const scope = browserId(args[0]), task = taskId(args[1]);
      return result(async () => (await get(id, scope, task)).snapshot());
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
      owner.automation.deactivate(selected); owner.selected = undefined;
    }),
    handleForWindow('task-browser:hide', trusted, (id, ...args) => {
      if (args.length !== 2) throw new Error('Invalid browser hide');
      const scope = browserId(args[0]), task = taskId(args[1]), selected = windows.get(id)?.selected;
      if (selected?.scopeId === scope && selected.taskId === task) selected.hide();
    }),
  ];
  const timer = setInterval(() => { for (const owner of windows.values()) for (const task of owner.tasks.values()) task.maintain(); }, 250);
  return { dispose() { clearInterval(timer); for (const stop of stops) stop(); for (const owner of [...windows.values()]) owner.cleanup(); windows.clear(); }, flush: () => persistence.flush() };
}
