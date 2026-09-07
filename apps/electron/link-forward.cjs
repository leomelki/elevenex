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
  socket.on('close', () => {
    // A socket closed before the stream finished means the local peer went
    // away mid-request; reset rather than leaving a half-open stream behind.
    if (!stream.destroyed && !stream.writableEnded) {
      fail();
    }
  });
  stream.on('close', () => {
    if (!socket.destroyed && !socket.writableEnded) {
      fail();
    }
  });

  socket.pipe(stream);
  stream.pipe(socket);
}

// Sharing side: every stream the peer opens is reconnected to the local backend.
function serveStreams(session, { targetHost = '127.0.0.1', targetPort, onError } = {}) {
  if (!Number.isInteger(targetPort) || targetPort <= 0) {
    throw new TypeError('serveStreams requires a target port');
  }

  session.on('stream', (stream) => {
    const socket = net.connect({ host: targetHost, port: targetPort });
    socket.setNoDelay(true);
    // Until the backend accepts, the peer's bytes queue in the stream's own
    // buffer; bridging only after 'connect' keeps write errors on one path.
    socket.once('connect', () => bridge(socket, stream, onError));
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
  const server = net.createServer((socket) => {
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
        server.closeAllConnections?.();
      });
    },
  };
}

module.exports = {
  bridge,
  createLocalListener,
  serveStreams,
};
