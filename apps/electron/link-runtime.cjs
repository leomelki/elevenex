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
const {
  awaitRelayPeer,
  connectDirect,
  createDirectServer,
} = require('./link-transport.cjs');
const { parseDirectEndpoint } = require('./link-pairing.cjs');

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15000;

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
async function establishSession(channel, { pairingKey, isInitiator }) {
  const secure = new SecureChannel(channel, { pairingKey, isInitiator });
  await secure.whenReady();
  return createMuxSession(secure, { isInitiator });
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
  constructor({ pairing, getTargetPort, bindHost = '0.0.0.0' }) {
    super();
    this.pairing = pairing;
    this.getTargetPort = getTargetPort;
    this.bindHost = bindHost;
    this.controller = null;
    this.directServer = null;
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
    } else {
      this.loop = this.#runRelayLoop();
    }
    return this.toStatus();
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
    });

    serveStreams(session, {
      targetPort,
      onError: (error) => this.emit('forward-error', error),
    });

    this.sessions.add(session);
    this.#setStatus('connected');

    await sessionClosed(session);

    this.sessions.delete(session);
    if (this.controller && !this.controller.signal.aborted) {
      this.#setStatus(this.sessions.size > 0 ? 'connected' : 'waiting');
    }
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
    if (this.loop) {
      await this.loop.catch(() => {});
      this.loop = null;
    }

    this.#setStatus('stopped');
    return this.toStatus();
  }
}

class LinkClient extends EventEmitter {
  constructor({ pairing, localPort = 0, localHost = '127.0.0.1' }) {
    super();
    this.pairing = pairing;
    this.requestedPort = localPort;
    this.localHost = localHost;
    this.localPort = null;
    this.listener = null;
    this.session = null;
    this.controller = null;
    this.loop = null;
    this.status = 'stopped';
    this.lastError = null;
  }

  toStatus() {
    return {
      status: this.status,
      transport: this.pairing.transport,
      endpoint: this.pairing.endpoint,
      pairId: this.pairing.pairId,
      localPort: this.localPort,
      backendUrl: this.localPort ? `http://127.0.0.1:${this.localPort}` : null,
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
      getSession: () => this.session,
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
    return awaitRelayPeer({
      endpoint: this.pairing.endpoint,
      pairId: this.pairing.pairId,
      role: 'client',
      signal,
    });
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
        });

        this.session = session;
        attempt = 0;
        this.#setStatus('connected');

        await sessionClosed(session);
        this.session = null;
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

  async stop() {
    if (!this.controller) {
      return this.toStatus();
    }
    this.controller.abort();
    this.controller = null;

    if (this.session) {
      this.session.close();
      this.session = null;
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
