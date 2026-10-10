// Project port forwards share the paired link, but own their loopback listeners.
// Operations for one definition are serialized; stop/disconnect also cancel starts.
'use strict';

const { createLocalListener } = require('./link-forward.cjs');
const { validForwardTarget } = require('./link-mux.cjs');

function createPortForwards({ getSession, getStatus }) {
  const entries = new Map();
  const operations = new Map();
  let closed = false;

  function view(id) {
    const entry = entries.get(id);
    return {
      id,
      // Connection errors do not stop the listener; the UI must still offer Stop.
      running: Boolean(entry?.listener?.server.listening),
      status: !entry ? 'inactive' : entry.error ? 'error'
        : getStatus() === 'connected' ? 'active' : 'connecting',
      pid: null,
      startedAt: entry?.startedAt ?? null,
      stoppedAt: null,
      lastError: entry?.error ?? (entry && getStatus() !== 'connected'
        ? 'Waiting for the paired desktop to reconnect. The local port will resume automatically.' : null),
      debugDetails: null,
    };
  }

  function serialize(id, operation) {
    const promise = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    operations.set(id, promise);
    return promise.finally(() => {
      if (operations.get(id) === promise) operations.delete(id);
    });
  }

  async function stopEntry(id) {
    const entry = entries.get(id);
    if (entry) {
      entries.delete(id);
      await entry.listener?.close();
    }
  }

  function start(payload) {
    const { id, localPort, remoteHost = 'localhost', remotePort, bindAddress = '127.0.0.1' } = payload ?? {};
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid forward id is required.');
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      throw new Error('Local port must be between 1 and 65535.');
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(bindAddress)) {
      throw new Error('Paired port forwards must bind to a loopback address.');
    }
    if (typeof remoteHost !== 'string') throw new Error('A remote host is required.');
    const target = { host: remoteHost.replace(/^\[(.*)\]$/, '$1'), port: remotePort };
    if (!validForwardTarget(target)) throw new Error('A valid remote host and port (1–65535) are required.');
    const config = JSON.stringify({ localPort, target, bindAddress });
    return serialize(id, async () => {
      if (closed) throw new Error('The paired desktop disconnected.');
      const existing = entries.get(id);
      if (existing?.config === config && existing.listener) {
        return view(id);
      }
      const session = getSession();
      if (!session?.isOpen()) throw new Error('Connect to the paired desktop before starting a forward.');
      await session.requirePortForwarding();
      if (closed || !session.isOpen()) throw new Error('The paired desktop disconnected.');
      await stopEntry(id);
      const entry = { config, listener: null, error: null, startedAt: new Date().toISOString() };
      const listener = createLocalListener({
        host: bindAddress === 'localhost' ? '127.0.0.1' : bindAddress,
        port: localPort, target, getSession,
        onConnect: () => { entry.error = null; },
        onError: (error) => {
          if (getSession()?.isOpen() && error.message !== 'Remote link closed') entry.error = error.message;
        },
      });
      entry.listener = listener;
      try {
        await listener.listen();
        if (closed) throw new Error('The paired desktop disconnected.');
        entries.set(id, entry);
      } catch (error) {
        await listener.close();
        const message = error.code === 'EADDRINUSE'
          ? `Local port ${localPort} is already in use. Stop the other service or choose a different local port in Advanced settings.`
          : error.code === 'EACCES' ? `Permission denied for local port ${localPort}. Choose a port above 1023.` : error.message;
        if (!closed) entries.set(id, { ...entry, listener: null, startedAt: null, error: message });
        throw new Error(message);
      }
      return view(id);
    });
  }

  function stop(id) {
    return serialize(id, async () => { await stopEntry(id); return view(id); });
  }

  async function close() {
    closed = true;
    await Promise.allSettled([...operations.values()]);
    await Promise.all([...entries.keys()].map(stopEntry));
  }

  return { start, stop, getState: view, close };
}

module.exports = { createPortForwards };
