// Elevenex link relay.
//
// A rendezvous that splices two WebSocket connections sharing a pairing id. It
// is deliberately dumb: it never inspects, stores or decrypts a byte of the
// session. The two ends run an X25519 handshake authenticated by the pairing key
// (see apps/electron/link-secure.cjs), so a relay operator sees ciphertext only
// and cannot impersonate either side.
//
// That is what makes it safe to run this anywhere — a small VPS, a container, a
// friend's box — and why it needs no accounts, no database and no TLS material
// of its own (terminate TLS at whatever reverse proxy fronts it).
//
// Run it with:  node apps/relay/server.cjs
// Configure it with PORT, HOST, RELAY_PATH, MAX_ROOMS, CLIENT_WAIT_TIMEOUT_MS.

'use strict';

const http = require('node:http');

const ws = require('../electron/link-ws.cjs');

const DEFAULTS = {
  port: 8787,
  host: '0.0.0.0',
  path: '/link',
  maxRooms: 10000,
  // A connecting device whose host is not sharing should be told so, rather than
  // hanging on a silent socket until the user gives up.
  clientWaitTimeoutMs: 30000,
  heartbeatIntervalMs: 30000,
  quiet: false,
};

const PAIR_ID_PATTERN = /^[0-9a-f]{32}$/;

function createRelayServer(options = {}) {
  const config = { ...DEFAULTS, ...options };
  /** @type {Map<string, { host: object | null, client: object | null }>} */
  const rooms = new Map();

  const log = (message, fields = {}) => {
    if (config.quiet) {
      return;
    }
    const parts = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
    process.stdout.write(
      `${new Date().toISOString()} ${message}${parts.length ? ` ${parts.join(' ')}` : ''}\n`,
    );
  };

  const sendControl = (side, control) => {
    try {
      side.channel.send(Buffer.from(JSON.stringify(control), 'utf8'), { binary: false });
    } catch {
      // Peer already gone; its close handler does the cleanup.
    }
  };

  const rejectConnection = (channel, message) => {
    try {
      channel.send(Buffer.from(JSON.stringify({ t: 'error', message }), 'utf8'), { binary: false });
    } catch {
      // Nothing to do — the socket is already unusable.
    }
    // Give the frame a tick to leave before the socket goes.
    setTimeout(() => channel.close(1008, 'rejected'), 10).unref?.();
  };

  const roomFor = (pairId) => {
    let room = rooms.get(pairId);
    if (!room) {
      room = { host: null, client: null };
      rooms.set(pairId, room);
    }
    return room;
  };

  const splice = (pairId, room) => {
    const { host, client } = room;
    if (!host || !client) {
      return;
    }

    for (const [side, peer] of [[host, client], [client, host]]) {
      if (side.waitTimer) {
        clearTimeout(side.waitTimer);
        side.waitTimer = null;
      }
      side.peer = peer;
    }

    log('spliced', { pair: pairId.slice(0, 8) });
    sendControl(host, { t: 'peer' });
    sendControl(client, { t: 'peer' });
  };

  const attach = (channel, pairId, role) => {
    const room = roomFor(pairId);

    const existing = room[role];
    if (existing) {
      // Almost always a stale socket from a device that slept or lost its
      // network before the close was noticed. Prefer the newcomer so a reconnect
      // is never blocked by a connection that is already dead.
      log('replacing stale side', { pair: pairId.slice(0, 8), role });
      existing.replaced = true;
      sendControl(existing, { t: 'error', message: 'Replaced by a newer connection.' });
      if (existing.peer) {
        existing.peer.peer = null;
      }
      existing.channel.close(1000, 'replaced');
    }

    const side = { channel, role, peer: null, waitTimer: null, replaced: false, alive: true };
    room[role] = side;

    channel.on('message', (message, isBinary) => {
      if (!isBinary) {
        return; // Control text is relay-to-endpoint only.
      }
      if (side.peer) {
        side.peer.channel.send(message, { binary: true });
      }
    });

    channel.on('pong', () => {
      side.alive = true;
    });

    channel.on('close', () => {
      if (room[role] === side) {
        room[role] = null;
      }
      if (side.waitTimer) {
        clearTimeout(side.waitTimer);
      }
      const peer = side.peer;
      if (peer && !side.replaced) {
        peer.peer = null;
        // Close the survivor too: both ends redial and wait, which resets the
        // session cleanly rather than leaving a half-dead splice in place.
        sendControl(peer, { t: 'peer-gone' });
        peer.channel.close(1000, 'peer disconnected');
      }
      if (!room.host && !room.client) {
        rooms.delete(pairId);
      }
      log('disconnected', { pair: pairId.slice(0, 8), role });
    });

    channel.on('error', () => {
      channel.close(1011, 'error');
    });

    log('connected', { pair: pairId.slice(0, 8), role, rooms: rooms.size });

    if (room.host && room.client) {
      splice(pairId, room);
    } else if (role === 'client' && config.clientWaitTimeoutMs > 0) {
      side.waitTimer = setTimeout(() => {
        if (!side.peer) {
          rejectConnection(
            channel,
            'No device is sharing with this pairing code right now. Open Elevenex on the other machine and make sure sharing is on.',
          );
        }
      }, config.clientWaitTimeoutMs);
      side.waitTimer.unref?.();
    }
  };

  const server = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Not found');
  });

  ws.attachServer(server, {
    path: config.path,
    onConnection: (channel, request) => {
      let query;
      try {
        query = new URL(request.url, 'http://relay.invalid').searchParams;
      } catch {
        rejectConnection(channel, 'Malformed request.');
        return;
      }

      const pairId = `${query.get('pair') || ''}`.toLowerCase();
      const role = `${query.get('role') || ''}`;

      if (!PAIR_ID_PATTERN.test(pairId)) {
        rejectConnection(channel, 'Invalid pairing id.');
        return;
      }
      if (role !== 'host' && role !== 'client') {
        rejectConnection(channel, 'Invalid role.');
        return;
      }
      if (!rooms.has(pairId) && rooms.size >= config.maxRooms) {
        rejectConnection(channel, 'The relay is at capacity, try again shortly.');
        return;
      }

      attach(channel, pairId, role);
    },
  });

  // Drop connections that stopped answering rather than holding their room open
  // against a reconnect from the same device.
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const side of [room.host, room.client]) {
        if (!side) {
          continue;
        }
        if (!side.alive) {
          side.channel.destroy();
          continue;
        }
        side.alive = false;
        side.channel.ping();
      }
    }
  }, config.heartbeatIntervalMs);
  heartbeat.unref?.();

  return {
    rooms,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.removeListener('error', reject);
          const { port } = server.address();
          log('relay listening', { host: config.host, port, path: config.path });
          resolve(port);
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const room of rooms.values()) {
        room.host?.channel.destroy();
        room.client?.channel.destroy();
      }
      rooms.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createRelayServer };

if (require.main === module) {
  const relay = createRelayServer({
    port: Number.parseInt(process.env.PORT || `${DEFAULTS.port}`, 10),
    host: process.env.HOST || DEFAULTS.host,
    path: process.env.RELAY_PATH || DEFAULTS.path,
    maxRooms: Number.parseInt(process.env.MAX_ROOMS || `${DEFAULTS.maxRooms}`, 10),
    clientWaitTimeoutMs: Number.parseInt(
      process.env.CLIENT_WAIT_TIMEOUT_MS || `${DEFAULTS.clientWaitTimeoutMs}`,
      10,
    ),
  });

  relay.listen().catch((error) => {
    process.stderr.write(`Relay failed to start: ${error.message}\n`);
    process.exit(1);
  });

  const shutdown = () => {
    relay.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
