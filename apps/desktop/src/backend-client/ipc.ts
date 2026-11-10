import { registerTaskTerminalIpc } from './task-terminal';
import { registerWorkspaceIpc } from './workspace';
import { registerSessionChatIpc } from './session-chat';
import { handleForWindow, type TrustedSender } from '../ipc';
import type { BackendClient } from './client';
import type { TerminalLifetime } from './terminal-lifetime';
import { registerTerminalStreamIpc } from './terminal-stream';
import { TerminalPreferences } from './terminal-preferences';
import { registerTerminalPreferencesIpc } from './terminal-preferences-ipc';
import type { TerminalStreamDiagnostic } from './terminal-stream-connection';

export function registerBackendClientIpc(client: BackendClient, trusted: TrustedSender, terminals?: Pick<TerminalLifetime, 'owner' | 'track'>, preferences = new TerminalPreferences(null), diagnoseTerminal?: (diagnostic: TerminalStreamDiagnostic) => void): () => void {
  const stopState = handleForWindow('backend-client:state', trusted, (windowId, ...args) => {
    if (args.length !== 0) throw new Error('Backend client state accepts no arguments');
    return client.state(windowId);
  });
  const stopInfo = handleForWindow('backend-client:info', trusted, (windowId, ...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string' || !/^[a-f0-9-]{36}$/.test(args[0])) {
      throw new Error('A backend scope id is required');
    }
    return client.info(windowId, args[0]);
  });
  const stopWorkspace = registerWorkspaceIpc(client, trusted);
  const stopChat = registerSessionChatIpc(client, trusted);
  const stopTerminals = registerTaskTerminalIpc(client, trusted, terminals);
  const stopStreams = registerTerminalStreamIpc(client, trusted, diagnoseTerminal);
  const stopPreferences = registerTerminalPreferencesIpc(client, trusted, preferences);
  return () => { stopState(); stopInfo(); stopWorkspace(); stopChat(); stopTerminals(); stopStreams(); stopPreferences(); };
}
