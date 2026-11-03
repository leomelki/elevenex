import { handleForWindow, type TrustedSender } from '../ipc';
import { action, bounds, file, target, presentation } from './validation';
import type { CodeSurfaces } from './surfaces';
export function registerCodeIpc(code: CodeSurfaces, trusted: TrustedSender): () => void {
  const handlers = [
    handleForWindow('code:window-context', trusted, (windowId, ...args) => { if (args.length) throw new Error('Code context accepts no arguments'); return code.windowContext(windowId); }),
    handleForWindow('code:open', trusted, (windowId, ...args) => { if (args.length !== 1) throw new Error('Code needs a target'); return code.open(windowId, target(args[0])); }),
    handleForWindow('code:present', trusted, (windowId, ...args) => { if (args.length !== 2) throw new Error('Code needs presentation state'); return code.present(windowId, target(args[0]), presentation(args[1])); }),
    handleForWindow('code:layout', trusted, (windowId, ...args) => { if (args.length !== 2) throw new Error('Code needs layout bounds'); return code.layout(windowId, target(args[0]), bounds(args[1])); }),
    handleForWindow('code:action', trusted, (windowId, ...args) => { if (args.length !== 2) throw new Error('Code needs an editor action'); return code.action(windowId, target(args[0]), action(args[1])); }),
    handleForWindow('code:focus', trusted, (windowId, ...args) => { if (args.length !== 1) throw new Error('Code needs a target'); return code.focus(windowId, target(args[0])); }),
    handleForWindow('code:recover', trusted, (windowId, ...args) => { if (args.length !== 1) throw new Error('Code needs a target'); return code.recover(windowId, target(args[0])); }),
    handleForWindow('code:detach', trusted, (windowId, ...args) => { if (args.length !== 1) throw new Error('Code needs a target'); return code.detach(windowId, target(args[0])); }),
    handleForWindow('code:release', trusted, (windowId, ...args) => { if (args.length !== 1) throw new Error('Code needs a target'); code.release(windowId, target(args[0])); }),
    handleForWindow('code:open-file', trusted, (windowId, ...args) => { if (args.length !== 2) throw new Error('Code needs a file'); return code.openFile(windowId, target(args[0]), file(args[1])); }),
  ];
  return () => { for (const stop of handlers) stop(); };
}
