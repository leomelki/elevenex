// TCP <-> mux stream bridging.
//
// This is the layer that makes the link a drop-in replacement for `ssh -L`: the
// connecting side gets a plain loopback port, and every TCP connection to it
// becomes one stream that the sharing side reconnects to the backend. No HTTP,
// WebSocket or socket.io framing is parsed anywhere — the same reason `-L` can
// carry all twelve gateways without knowing anything about them.

'use strict';

const net = require('node:net');

// Half-close is meaningful here: an HTTP client that has finished its request
// body still needs the response, so an EOF in one direction must not tear down
// the other. `pipe` already ends the destination on source EOF, which is
// exactly the semantics we want; only failures need wiring.
function bridge(socket, stream, onError) {
  let settled = false;
  const fail = (error) => {
    if (settled) {
      return;
    }
    settled = true;
    socket.destroy();
    stream.destroy();
    if (error && onError) {
      onError(error);
    }
  };

  socket.on('error', fail);
  stream.on('error', fail);
  // close means the resource is gone, even after a FIN in just one direction.
  // Leaving the other half alive leaks mux slots and backend keep-alive sockets.
  socket.on('close', () => stream.destroy());
  stream.on('close', () => socket.destroy());

  socket.pipe(stream);
  stream.pipe(socket);
}

// Sharing side: every stream the peer opens is reconnected to the local backend.
function serveStreams(session, { targetHost = '127.0.0.1', targetPort, getTargetPort, onError } = {}) {
  if (!getTargetPort && (!Number.isInteger(targetPort) || targetPort <= 0)) {
    throw new TypeError('serveStreams requires a target port');
  }

  session.on('stream', (stream) => {
    const port = getTargetPort ? getTargetPort() : targetPort;
    if (!Number.isInteger(port) || port <= 0) {
      stream.destroy();
      onError?.(new Error('The shared backend is not running.'));
      return;
    }
    const socket = net.connect({ host: targetHost, port, allowHalfOpen: true });
    socket.setNoDelay(true);
    // Until the backend accepts, the peer's bytes queue in the stream's own
    // buffer; bridging only after 'connect' keeps write errors on one path.
    const onStreamError = () => socket.destroy();
    const onStreamClose = () => socket.destroy();
    stream.on('error', onStreamError);
    stream.once('close', onStreamClose);
    socket.once('connect', () => {
      stream.removeListener('error', onStreamError);
      stream.removeListener('close', onStreamClose);
      if (stream.destroyed) socket.destroy();
      else bridge(socket, stream, onError);
    });
    socket.once('error', (error) => {
      stream.destroy();
      if (onError) {
        onError(error);
      }
    });
  });
}

// Connecting side: a loopback listener whose connections become streams.
function createLocalListener(
  { host = '127.0.0.1', port = 0, getSession, onError } = {},
) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const session = getSession();
    if (!session || !session.isOpen()) {
      // No live link: refuse immediately so the caller sees a connection error
      // and retries, rather than hanging on a socket that will never answer.
      socket.destroy();
      return;
    }

    socket.setNoDelay(true);
    let stream;
    try {
      stream = session.open();
    } catch (error) {
      socket.destroy();
      if (onError) {
        onError(error);
      }
      return;
    }
    bridge(socket, stream, onError);
  });

  server.on('error', (error) => {
    if (onError) {
      onError(error);
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        // close() alone waits for every open connection to end on its own,
        // which a held-open WebSocket never does. Stopping a link means
        // stopping it now.
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

module.exports = {
  bridge,
  createLocalListener,
  serveStreams,
};
