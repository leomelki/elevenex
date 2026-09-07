// Lifecycle for both ends of a remote link.
//
// Sharing side (`createLinkHost`): waits for a peer, authenticates it against the
// pairing key, and reconnects each forwarded stream to the local backend.
//
// Connecting side (`createLinkClient`): binds a loopback port up front — the way
// `ssh -L` allocates its local port before the tunnel is up — and keeps a
// session behind it, redialling with backoff whenever the link drops. Holding
// the port stable across reconnects is what lets the window keep its backend
// origin instead of having to renegotiate one after every network blip.

'use strict';

const { EventEmitter } = require('node:events');

const { SecureChannel } = require('./link-secure.cjs');
const { createLocalListener, serveStreams } = require('./link-forward.cjs');
const { createMuxSession } = require('./link-mux.cjs');
const { PeerChannel, attemptDirectUpgrade } = require('./link-upgrade.cjs');
const {
  awaitRelayPeer,
  connectDirect,
  createDirectServer,
} = require('./link-transport.cjs');
const { parseDirectEndpoint } = require('./link-pairing.cjs');
const { DEFAULT_STRATEGIES } = require('./link-rendezvous.cjs');

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15000;

// How long to sit in a rendezvous room before trying the next broker family.
// Giving up rejoins rather than ending the link: the other machine may simply
// not be awake yet.
const RENDEZVOUS_TIMEOUT_MS = 12000;

// Every mux frame becomes one data-channel message, so p2p sessions use the
// same conservative frame size as an upgraded relay session — well inside
// SCTP's comfortable range, rather than relying on large-message fragmentation.
const PEER_FRAME_BYTES = 64 * 1024;

function backoffDelay(attempt) {
  const delay = RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt, 6);
  // Jitter keeps two devices that dropped together from redialling in lockstep.
  return Math.min(delay, RECONNECT_MAX_DELAY_MS) * (0.5 + Math.random() * 0.5);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// Runs the handshake and hands back a live mux session, or throws.
async function establishSession(channel, { pairingKey, isInitiator, maxFrameBytes }) {
  const secure = new SecureChannel(channel, { pairingKey, isInitiator });
  await secure.whenReady();
  return createMuxSession(secure, { isInitiator, ...(maxFrameBytes ? { maxFrameBytes } : {}) });
}

// A rendezvous hands out every device holding the pairing key, and the same
// device arrives once per broker that found it. The first one wins; the rest are
// dropped, which costs a duplicate connection the other side then closes.
function firstRendezvousPeer(rendezvous, { signal, timeoutMs = RENDEZVOUS_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };

    // Stays attached after the promise settles: duplicates arrive later, by
    // definition, and something has to close them.
    const onPeer = (peer) => {
      if (settled) {
        peer.close();
        return;
      }
      finish(resolve, peer);
    };

    const onAbort = () => finish(reject, new Error('The link was stopped.'));
    const timer = setTimeout(
      () => finish(reject, new Error('No device answered this pairing code.')),
      timeoutMs,
    );
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    // Later arrivals are duplicates of a peer we already have.
    rendezvous.on('peer', onPeer);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sessionClosed(session) {
  return new Promise((resolve) => {
    if (!session.isOpen()) {
      resolve();
      return;
    }
    session.once('close', resolve);
  });
}

class LinkHost extends EventEmitter {
  constructor({
    pairing,
    getTargetPort,
    bindHost = '0.0.0.0',
    createPeer = null,
    openRendezvous = null,
  }) {
    super();
    this.pairing = pairing;
    this.getTargetPort = getTargetPort;
    this.bindHost = bindHost;
    this.createPeer = createPeer;
    this.openRendezvous = openRendezvous;
    this.controller = null;
    this.directServer = null;
    this.rendezvous = null;
    this.sessions = new Set();
    this.status = 'stopped';
    this.lastError = null;
    this.loop = null;
  }

  toStatus() {
    return {
      status: this.status,
      transport: this.pairing.transport,
      endpoint: this.pairing.endpoint,
      pairId: this.pairing.pairId,
      connectedPeers: this.sessions.size,
      error: this.lastError,
    };
  }

  #setStatus(status, error = null) {
    this.status = status;
    this.lastError = error;
    this.emit('status', this.toStatus());
  }

  async start() {
    if (this.controller) {
      return this.toStatus();
    }
    this.controller = new AbortController();
    this.#setStatus('starting');

    if (this.pairing.transport === 'direct') {
      await this.#startDirect();
    } else if (this.pairing.transport === 'p2p') {
      this.#startRendezvous();
    } else {
      this.loop = this.#runRelayLoop();
    }
    return this.toStatus();
  }

  // Nothing is bound and nothing is dialled: the room is joined and devices
  // holding the pairing key turn up in it. Several may, exactly as several may
  // dial an open port, so every peer is adopted.
  #startRendezvous() {
    if (!this.openRendezvous) {
      this.#setStatus('error', 'Peer-to-peer sharing is only available in the desktop app.');
      throw new Error('Peer-to-peer sharing is not available here.');
    }

    this.rendezvous = this.openRendezvous({ pairingKey: this.pairing.pairingKey });
    this.rendezvous.on('peer', (peer) => {
      // A peer that cannot prove it holds the pairing key is expected noise on
      // a public broker, and must not take the room down.
      this.#adoptChannel(new PeerChannel(peer)).catch(() => peer.close());
    });
    this.rendezvous.on('error', (error) => {
      // One broker failing is survivable — the others are still listening — so
      // this is reported without tearing the room down.
      this.emit('forward-error', error);
    });

    this.#setStatus('waiting');
  }

  async #startDirect() {
    const { port } = parseDirectEndpoint(this.pairing.endpoint);
    this.directServer = createDirectServer({
      host: this.bindHost,
      port,
      onChannel: (channel) => {
        // A wrong key must not take the listener down — an unauthenticated
        // dialler is expected noise on an open port.
        this.#adoptChannel(channel).catch(() => channel.close());
      },
      onError: (error) => this.#setStatus('error', error.message),
    });

    try {
      await this.directServer.listen();
      this.#setStatus('waiting');
    } catch (error) {
      this.directServer = null;
      this.#setStatus('error', error.message);
      throw error;
    }
  }

  async #runRelayLoop() {
    let attempt = 0;
    const { signal } = this.controller;

    while (!signal.aborted) {
      try {
        this.#setStatus('waiting');
        const channel = await awaitRelayPeer({
          endpoint: this.pairing.endpoint,
          pairId: this.pairing.pairId,
          role: 'host',
          signal,
        });
        attempt = 0;
        await this.#adoptChannel(channel);
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        this.#setStatus('reconnecting', error.message);
        attempt += 1;
        await sleep(backoffDelay(attempt), signal);
      }
    }

    if (!signal.aborted) {
      this.#setStatus('stopped');
    }
  }

  async #adoptChannel(channel) {
    const targetPort = this.getTargetPort();
    if (!Number.isInteger(targetPort) || targetPort <= 0) {
      channel.close();
      throw new Error('The local backend is not running yet.');
    }

    const session = await establishSession(channel, {
      pairingKey: this.pairing.pairingKey,
      isInitiator: false,
      maxFrameBytes: this.pairing.transport === 'p2p' ? PEER_FRAME_BYTES : 0,
    });

    serveStreams(session, {
      targetPort,
      onError: (error) => this.emit('forward-error', error),
    });

    this.sessions.add(session);
    this.#setStatus('connected');

    // The sharing side answers the upgrade; the connecting side offers. Not
    // awaited: the relay session is already serving traffic and stays the
    // fallback whether or not this succeeds.
    void this.#upgrade(session, targetPort);

    await sessionClosed(session);

    this.sessions.delete(session);
    if (this.controller && !this.controller.signal.aborted) {
      this.#setStatus(this.sessions.size > 0 ? 'connected' : 'waiting');
    }
  }

  // Serves the direct session exactly like the relayed one. Both stay live: the
  // connecting side decides which to open new streams on.
  async #upgrade(relaySession, targetPort) {
    // Only a relayed session has anything to upgrade to: direct and p2p
    // sessions are already the fast path.
    if (!this.createPeer || this.pairing.transport !== 'relay') {
      return;
    }

    const direct = await attemptDirectUpgrade({
      session: relaySession,
      pairingKey: this.pairing.pairingKey,
      isInitiator: false,
      createPeer: this.createPeer,
      signal: this.controller?.signal,
    }).catch(() => null);

    if (!direct) {
      return;
    }

    serveStreams(direct, {
      targetPort,
      onError: (error) => this.emit('forward-error', error),
    });
    this.sessions.add(direct);
    this.emit('upgraded', { transport: 'direct' });

    await sessionClosed(direct);
    this.sessions.delete(direct);
  }

  async stop() {
    if (!this.controller) {
      return this.toStatus();
    }
    this.controller.abort();
    this.controller = null;

    for (const session of [...this.sessions]) {
      session.close();
    }
    this.sessions.clear();

    if (this.directServer) {
      await this.directServer.close();
      this.directServer = null;
    }
    if (this.rendezvous) {
      this.rendezvous.close();
      this.rendezvous = null;
    }
    if (this.loop) {
      await this.loop.catch(() => {});
      this.loop = null;
    }

    this.#setStatus('stopped');
    return this.toStatus();
  }
}

class LinkClient extends EventEmitter {
  constructor({
    pairing,
    localPort = 0,
    localHost = '127.0.0.1',
    createPeer = null,
    openRendezvous = null,
  }) {
    super();
    this.pairing = pairing;
    this.requestedPort = localPort;
    this.localHost = localHost;
    this.createPeer = createPeer;
    this.openRendezvous = openRendezvous;
    this.rendezvous = null;
    this.rendezvousAttempt = 0;
    this.localPort = null;
    this.listener = null;
    this.session = null;
    // Set once a peer-to-peer path is up. New connections go here; the relay
    // session stays open underneath so losing it is a downgrade, not an outage.
    this.directSession = null;
    this.controller = null;
    this.loop = null;
    this.status = 'stopped';
    this.lastError = null;
  }

  // Which session new forwarded connections should use.
  activeSession() {
    if (this.directSession?.isOpen()) {
      return this.directSession;
    }
    return this.session;
  }

  toStatus() {
    return {
      status: this.status,
      transport: this.pairing.transport,
      endpoint: this.pairing.endpoint,
      pairId: this.pairing.pairId,
      localPort: this.localPort,
      backendUrl: this.localPort ? `http://127.0.0.1:${this.localPort}` : null,
      // How traffic is actually flowing right now, as opposed to how the two
      // ends found each other. Only a relay pairing can be on a relay: the other
      // two transports carry traffic between the machines from the start.
      path: this.pairing.transport !== 'relay' || this.directSession?.isOpen()
        ? 'direct'
        : 'relay',
      error: this.lastError,
    };
  }

  #setStatus(status, error = null, { rejected = false } = {}) {
    this.status = status;
    this.lastError = error;
    this.emit('status', { ...this.toStatus(), rejected });
  }

  async start() {
    if (this.controller) {
      return this.toStatus();
    }
    this.controller = new AbortController();
    this.#setStatus('starting');

    this.listener = createLocalListener({
      host: this.localHost,
      port: this.requestedPort,
      getSession: () => this.activeSession(),
      onError: (error) => this.emit('forward-error', error),
    });

    try {
      this.localPort = await this.listener.listen();
    } catch (error) {
      this.listener = null;
      this.controller = null;
      this.#setStatus('error', error.message);
      throw error;
    }

    this.loop = this.#runLoop();
    return this.toStatus();
  }

  // Resolves once a session is live, so callers can await a usable backend
  // rather than polling the port.
  whenConnected({ timeoutMs = 45000 } = {}) {
    if (this.status === 'connected') {
      return Promise.resolve(this.toStatus());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('status', onStatus);
        reject(new Error(this.lastError || 'Timed out connecting to the shared device.'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      const onStatus = (status) => {
        if (status.status === 'connected') {
          clearTimeout(timer);
          this.removeListener('status', onStatus);
          resolve(status);
        } else if (status.status === 'stopped' || status.rejected) {
          // `rejected` means the relay gave a definite answer — nobody is
          // sharing this code, most often. Waiting out the timeout would only
          // turn a clear message into a vague one. The loop keeps retrying in
          // the background, so a device that starts sharing later still lands.
          clearTimeout(timer);
          this.removeListener('status', onStatus);
          reject(new Error(status.error || 'The link was stopped.'));
        }
      };
      this.on('status', onStatus);
    });
  }

  async #openChannel(signal) {
    if (this.pairing.transport === 'direct') {
      const { host, port } = parseDirectEndpoint(this.pairing.endpoint);
      return connectDirect({ host, port });
    }
    if (this.pairing.transport === 'p2p') {
      return this.#openRendezvousChannel(signal);
    }
    return awaitRelayPeer({
      endpoint: this.pairing.endpoint,
      pairId: this.pairing.pairId,
      role: 'client',
      signal,
    });
  }

  // The room has to stay joined for the life of the connection — Trystero owns
  // the peer connection and leaving would close it — so it is torn down with the
  // channel, and the next attempt starts a fresh one rather than trying to
  // resurrect a room whose peer state is already stale.
  async #openRendezvousChannel(signal) {
    if (!this.openRendezvous) {
      throw new Error('Peer-to-peer links are only available in the desktop app.');
    }

    // One broker family per attempt, rotating on failure. The sharing side
    // waits in all of them at once — it has nothing better to do — but a
    // connecting side that did the same would be introduced to the same machine
    // once per broker and have to throw the extra connections away. Redundancy
    // is preserved either way: a family that is down simply loses its turn.
    const strategy = DEFAULT_STRATEGIES[this.rendezvousAttempt % DEFAULT_STRATEGIES.length];
    this.rendezvousAttempt += 1;

    const rendezvous = this.openRendezvous({
      pairingKey: this.pairing.pairingKey,
      strategies: [strategy],
    });
    try {
      const peer = await firstRendezvousPeer(rendezvous, { signal });
      const channel = new PeerChannel(peer);
      channel.once('close', () => rendezvous.close());
      this.rendezvous = rendezvous;
      return channel;
    } catch (error) {
      rendezvous.close();
      throw error;
    }
  }

  async #runLoop() {
    let attempt = 0;
    const { signal } = this.controller;

    while (!signal.aborted) {
      try {
        this.#setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
        const channel = await this.#openChannel(signal);
        const session = await establishSession(channel, {
          pairingKey: this.pairing.pairingKey,
          isInitiator: true,
          maxFrameBytes: this.pairing.transport === 'p2p' ? PEER_FRAME_BYTES : 0,
        });

        this.session = session;
        attempt = 0;
        this.#setStatus('connected');

        void this.#upgrade(session);

        await sessionClosed(session);
        this.session = null;
        // The direct path rides on signalling from the relay session and is
        // meaningless without a way to rebuild it, so it goes too.
        this.directSession?.close();
        this.directSession = null;
        if (signal.aborted) {
          break;
        }
        this.#setStatus('reconnecting', 'The link dropped.');
      } catch (error) {
        this.session = null;
        if (signal.aborted) {
          break;
        }
        this.#setStatus('reconnecting', error.message, {
          rejected: error.code === 'RELAY_REJECTED',
        });
      }

      attempt += 1;
      await sleep(backoffDelay(attempt), signal);
    }
  }

  // The connecting side offers; the sharing side answers.
  async #upgrade(relaySession) {
    if (!this.createPeer || this.pairing.transport !== 'relay') {
      return;
    }

    const direct = await attemptDirectUpgrade({
      session: relaySession,
      pairingKey: this.pairing.pairingKey,
      isInitiator: true,
      createPeer: this.createPeer,
      signal: this.controller?.signal,
    }).catch(() => null);

    if (!direct || relaySession !== this.session) {
      // The relay session this upgrade belonged to has already been replaced.
      direct?.close();
      return;
    }

    this.directSession = direct;
    this.#setStatus(this.status);

    await sessionClosed(direct);
    if (this.directSession === direct) {
      this.directSession = null;
      // New connections silently return to the relay.
      this.#setStatus(this.status);
    }
  }

  async stop() {
    if (!this.controller) {
      return this.toStatus();
    }
    this.controller.abort();
    this.controller = null;

    if (this.directSession) {
      this.directSession.close();
      this.directSession = null;
    }
    if (this.session) {
      this.session.close();
      this.session = null;
    }
    if (this.rendezvous) {
      this.rendezvous.close();
      this.rendezvous = null;
    }
    if (this.listener) {
      await this.listener.close();
      this.listener = null;
    }
    if (this.loop) {
      await this.loop.catch(() => {});
      this.loop = null;
    }

    this.localPort = null;
    this.#setStatus('stopped');
    return this.toStatus();
  }
}

function createLinkHost(options) {
  return new LinkHost(options);
}

function createLinkClient(options) {
  return new LinkClient(options);
}

module.exports = {
  LinkClient,
  LinkHost,
  createLinkClient,
  createLinkHost,
};
