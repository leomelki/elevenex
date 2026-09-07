// Owns every remote link this app is part of, on both sides.
//
// Sharing side: at most one, because a machine offers one backend.
// Connecting side: one LinkClient per saved link, each holding a loopback port
// that a window can point at exactly like an `ssh -L` port.
//
// Pairing keys never leave this module in cleartext except through
// getSharingCode(), which exists so the user can copy the code once.

'use strict';

const os = require('node:os');
const path = require('node:path');

const { createLinkClient, createLinkHost } = require('./link-runtime.cjs');
const { createLinkStore } = require('./link-store.cjs');
const {
  createPairing,
  decodePairingCode,
  encodePairingCode,
} = require('./link-pairing.cjs');

function defaultHostLabel() {
  try {
    return os.hostname() || 'Elevenex device';
  } catch {
    return 'Elevenex device';
  }
}

function createLinkManager({
  userDataPath,
  getLocalBackendPort,
  // Builds WebRTC peers. Optional: without it links stay on the relay, which is
  // what the tests and any non-Electron caller do.
  createPeer = null,
  onSharingStatus = () => {},
  onLinkStatus = () => {},
  onError = () => {},
}) {
  const store = createLinkStore({
    filePath: path.join(userDataPath, 'remote-links.json'),
    onError,
  });

  let host = null;
  let hostStatus = { status: 'stopped', connectedPeers: 0, error: null };
  /** @type {Map<number, { client: object, status: object }>} */
  const clients = new Map();

  // --- sharing ------------------------------------------------------------

  function sharingView() {
    const sharing = store.getSharing();
    if (!sharing) {
      return {
        configured: false,
        enabled: false,
        transport: null,
        endpoint: null,
        label: '',
        status: 'stopped',
        connectedPeers: 0,
        error: null,
      };
    }
    return {
      configured: true,
      enabled: sharing.enabled,
      transport: sharing.transport,
      endpoint: sharing.endpoint,
      label: sharing.label,
      createdAt: sharing.createdAt,
      status: hostStatus.status,
      connectedPeers: hostStatus.connectedPeers || 0,
      error: hostStatus.error,
    };
  }

  function emitSharing() {
    onSharingStatus(sharingView());
  }

  async function stopHost() {
    if (!host) {
      return;
    }
    const running = host;
    host = null;
    await running.stop().catch(() => {});
    hostStatus = { status: 'stopped', connectedPeers: 0, error: null };
  }

  async function startHost(sharing) {
    await stopHost();

    host = createLinkHost({
      pairing: sharing,
      getTargetPort: () => getLocalBackendPort(),
      // A direct pairing names a port the other machine dials, so it has to be
      // reachable from outside this host. Relay pairings never bind anything.
      bindHost: '0.0.0.0',
      createPeer,
    });

    host.on('status', (status) => {
      hostStatus = status;
      emitSharing();
    });
    host.on('forward-error', (error) => onError(error));

    await host.start();
    emitSharing();
  }

  async function enableSharing({ transport = 'relay', relayUrl = '', directPort = 0, label = '' } = {}) {
    if (transport === 'relay' && !`${relayUrl}`.trim()) {
      throw new Error('A relay URL is required to share over a relay.');
    }
    if (transport === 'direct' && !Number(directPort)) {
      throw new Error('A port is required to share directly.');
    }

    // The endpoint is what the *other* machine dials, so a direct pairing
    // advertises a reachable address rather than the wildcard this side binds.
    const endpoint = transport === 'relay'
      ? `${relayUrl}`.trim()
      : `${hostAdvertisedHost()}:${Number(directPort)}`;

    const existing = store.getSharing();
    // Reuse the pairing when nothing addressable changed, so turning sharing off
    // and on again does not invalidate a code the user already saved on their
    // other machine.
    const reusable = existing
      && existing.transport === transport
      && existing.endpoint === endpoint;

    const pairing = reusable
      ? existing
      : createPairing({
        transport,
        endpoint,
        label: label || defaultHostLabel(),
      });

    const saved = store.setSharing(pairing, { enabled: true });
    await startHost(saved);
    return sharingView();
  }

  // For a direct pairing the code has to carry an address the *other* machine
  // can dial. There is no reliable way to know that from inside this process, so
  // the LAN address is a starting point the user can correct.
  function hostAdvertisedHost() {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          return entry.address;
        }
      }
    }
    return '127.0.0.1';
  }

  async function disableSharing() {
    await stopHost();
    store.setSharingEnabled(false);
    emitSharing();
    return sharingView();
  }

  async function regenerateSharingCode() {
    const existing = store.getSharing();
    if (!existing) {
      throw new Error('Sharing has not been set up yet.');
    }
    const pairing = createPairing({
      transport: existing.transport,
      endpoint: existing.endpoint,
      label: existing.label || defaultHostLabel(),
    });
    const saved = store.setSharing(pairing, { enabled: existing.enabled });
    if (existing.enabled) {
      await startHost(saved);
    }
    emitSharing();
    return getSharingCode();
  }

  // The one call that returns the secret. Kept separate from the status view so
  // a routine poll can never leak it into a log or a renderer cache.
  function getSharingCode() {
    const sharing = store.getSharing();
    if (!sharing) {
      return null;
    }
    return encodePairingCode(sharing);
  }

  async function restoreSharing() {
    const sharing = store.getSharing();
    if (sharing?.enabled) {
      await startHost(sharing).catch((error) => {
        hostStatus = { status: 'error', connectedPeers: 0, error: error.message };
        onError(error);
        emitSharing();
      });
    }
  }

  // --- saved links --------------------------------------------------------

  function linkView(link) {
    const runtime = clients.get(link.id);
    const status = runtime?.status || { status: 'stopped', localPort: null, backendUrl: null, error: null };
    return {
      id: link.id,
      name: link.name,
      transport: link.transport,
      endpoint: link.endpoint,
      createdAt: link.createdAt,
      lastConnectedAt: link.lastConnectedAt,
      status: status.status,
      localPort: status.localPort ?? null,
      backendUrl: status.backendUrl ?? null,
      // 'direct' once a peer-to-peer path is carrying traffic, 'relay' until then.
      path: status.path ?? 'relay',
      error: status.error ?? null,
    };
  }

  function listLinks() {
    return store.listLinks().map(linkView);
  }

  function getLinkState(id) {
    const link = store.getLink(id);
    return link ? linkView(link) : null;
  }

  function addLink({ code, name = '' }) {
    const pairing = decodePairingCode(code);
    const existing = store.listLinks().find((link) => link.pairId === pairing.pairId);
    if (existing) {
      throw new Error(`This device is already saved as “${existing.name}”.`);
    }
    return linkView(store.addLink({ name, pairing }));
  }

  function renameLink(id, name) {
    const link = store.renameLink(id, name);
    return link ? linkView(link) : null;
  }

  async function removeLink(id) {
    await disconnect(id);
    return store.removeLink(id);
  }

  async function connect(id) {
    const link = store.getLink(id);
    if (!link) {
      throw new Error('That saved device no longer exists.');
    }

    const existing = clients.get(link.id);
    if (existing) {
      if (existing.status.status === 'connected') {
        return linkView(store.getLink(id));
      }
      // A client that is mid-reconnect is worth waiting on rather than
      // replacing: tearing it down would drop the loopback port a window is
      // already pointed at.
      await existing.client.whenConnected().catch(() => {});
      return linkView(store.getLink(id));
    }

    const client = createLinkClient({ pairing: link, localPort: 0, createPeer });
    const runtime = { client, status: client.toStatus() };
    clients.set(link.id, runtime);

    client.on('status', (status) => {
      runtime.status = status;
      onLinkStatus({ id: link.id, ...linkView(store.getLink(link.id) || link) });
    });
    client.on('forward-error', (error) => onError(error));

    try {
      await client.start();
      await client.whenConnected();
      store.markConnected(link.id);
    } catch (error) {
      clients.delete(link.id);
      await client.stop().catch(() => {});
      throw error;
    }

    return linkView(store.getLink(link.id));
  }

  async function disconnect(id) {
    const runtime = clients.get(Number(id));
    if (!runtime) {
      return false;
    }
    clients.delete(Number(id));
    await runtime.client.stop().catch(() => {});
    const link = store.getLink(id);
    if (link) {
      onLinkStatus({ id: Number(id), ...linkView(link) });
    }
    return true;
  }

  async function stopAll() {
    await stopHost();
    await Promise.all([...clients.keys()].map((id) => disconnect(id)));
  }

  return {
    addLink,
    connect,
    defaultHostLabel,
    disableSharing,
    disconnect,
    enableSharing,
    getLinkState,
    getSharingCode,
    hostAdvertisedHost,
    listLinks,
    regenerateSharingCode,
    removeLink,
    renameLink,
    restoreSharing,
    sharingView,
    stopAll,
  };
}

module.exports = { createLinkManager };
