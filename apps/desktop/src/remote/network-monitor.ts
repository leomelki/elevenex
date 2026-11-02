import { networkInterfaces } from 'node:os';

/** Observe route/interface changes (including VPN) without probing a host or exposing addresses. */
export function monitorNetwork(online: () => boolean, changed: () => void): () => void {
  const snapshot = () => JSON.stringify([online(), Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => [entry.address, entry.netmask]) ?? []).sort()]);
  // This bounded OS snapshot is synchronous; it never scans files or starts a process.
  let previous = snapshot();
  const timer = setInterval(() => {
    const next = snapshot();
    if (next !== previous) { previous = next; changed(); }
  }, 5000);
  timer.unref();
  return () => clearInterval(timer);
}
