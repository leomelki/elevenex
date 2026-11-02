import { BrowserWindow, Notification } from 'electron';
import type { RemoteManager } from './manager';

/** Background asks never include SSH prompt text, credential data or endpoint addresses. */
export function notifyRecovery(remote: RemoteManager): () => void {
  const seen = new Map<string, string>();
  const notices = new Map<string, { readonly close: () => void }>();
  const stop = remote.subscribe((windowId, snapshot) => {
    if (snapshot.selection.kind !== 'remote') return;
    const hostId = snapshot.selection.hostId;
    if (snapshot.connection?.phase === 'ready') { seen.delete(hostId); notices.get(hostId)?.close(); return; }
    const identity = (snapshot.challenge ? `${snapshot.challenge.id}:${windowId}` : null) ?? (snapshot.connection?.phase === 'paused' && snapshot.connection.failure?.action === 'authenticate' ? 'authenticate' : null);
    if (!identity || seen.get(hostId) === identity) return;
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.id === windowId);
    if (!window || window.isDestroyed() || window.isFocused() || !Notification.isSupported()) return;
    seen.set(hostId, identity);
    if (seen.size > 100) { const oldest = seen.keys().next().value!; seen.delete(oldest); notices.get(oldest)?.close(); }
    notices.get(hostId)?.close();
    const name = remote.hosts().find(host => host.id === hostId)?.name ?? 'Machine';
    const notice = new Notification({ title: `${name} needs you to reconnect`, body: 'Open Elevenex to continue the SSH connection.' });
    const closed = () => { window.removeListener('closed', close); notice.removeAllListeners(); notices.delete(hostId); };
    const close = () => { notice.close(); closed(); };
    notices.set(hostId, { close });
    window.once('closed', close);
    notice.once('close', closed);
    notice.once('click', () => { if (!window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } close(); });
    notice.show();
  });
  return () => { stop(); for (const notice of notices.values()) notice.close(); notices.clear(); seen.clear(); };
}
