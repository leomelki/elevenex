import type { EnvironmentSelection } from '@elevenex/shared';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { handleForWindow, type TrustedSender } from '../ipc';
import { arity, text } from '../remote/validation';
import type { MachineApplication } from './application';
import { sshHostSuggestions } from './ssh-hosts';

export function registerMachineIpc(machines: MachineApplication, trusted: TrustedSender, openWindow: (selection: EnvironmentSelection | null) => void): () => void {
  const stops = [
    handleForWindow('machines:state', trusted, (id, ...args) => { arity(args, 0); return machines.snapshot(id); }),
    handleForWindow('machines:edit', trusted, (id, ...args) => { arity(args, 2); return machines.edit(id, args[0], args[1]); }),
    handleForWindow('machines:disconnect', trusted, (id, ...args) => { arity(args, 1); return machines.disconnect(id, args[0]); }),
    handleForWindow('machines:remove', trusted, (id, ...args) => { arity(args, 2); return machines.remove(id, args[0], args[1]); }),
    handleForWindow('machines:undo-remove', trusted, (id, ...args) => { arity(args, 1); return machines.undoRemove(id, args[0]); }),
    handleForWindow('machines:dismiss-removal', trusted, (id, ...args) => { arity(args, 1); machines.dismissRemoval(id, args[0]); }),
    handleForWindow('machines:opened', trusted, (id, ...args) => { arity(args, 1); return machines.opened(id, args[0]); }),
    handleForWindow('machines:new-window', trusted, (_id, ...args) => { arity(args, 1); openWindow(machines.validateSelection(args[0])); }),
    handleForWindow('machines:ssh-hosts', trusted, (_id, ...args) => {
      arity(args, 1);
      return sshHostSuggestions(join(homedir(), '.ssh', 'config'), text(args[0], 253, true));
    }),
  ];
  return () => { for (const stop of stops) stop(); };
}
