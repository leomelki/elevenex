// Runs in the hidden renderer created by link-rendezvous.cjs.
//
// Trystero is browser-only and ESM-only, so it is dynamic-imported here rather
// than required in the main process. A preload has the page's web APIs —
// WebSocket, RTCPeerConnection, and crypto.subtle, which only exists because the
// page is served over a privileged scheme and is therefore a secure context —
// while the page itself stays empty and unreachable by anything else.
//
// One room is joined per strategy. Peer ids are namespaced by strategy because
// Trystero identities are per-module-instance: the same remote device appears
// under a different id on each broker, and finding it twice is a duplicate to
// resolve upstream rather than a collision to hide here.

'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ipcRenderer } = require('electron');

// One bundled module rather than the packages themselves: see
// link-rendezvous-entry.mjs for why they cannot be imported as shipped files.
//
// The bundle is unpacked from the asar (see `asarUnpack` in package.json)
// because Node's ESM loader reads a file: URL straight off the disk rather than
// through Electron's asar shim, so the packed path would simply not exist.
const BUNDLE_URL = pathToFileURL(
  path
    .join(__dirname, 'vendor', 'rendezvous.mjs')
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`),
).href;

const ACTION_ID = 'link';

let bundle = null;

function loadStrategies() {
  if (!bundle) {
    bundle = import(BUNDLE_URL).then((module) => module.strategies);
  }
  return bundle;
}

/**
 * @type {Map<number, {
 *   rooms: object[],
 *   send: Map<string, Function>,
 *   close: Map<string, Function>,
 * }>}
 */
const sessions = new Map();

let port = null;

function post(message) {
  port?.postMessage(message);
}

async function join({ id, appId, room: roomId, password, strategies, rtcConfig }) {
  const session = { rooms: [], send: new Map(), close: new Map() };
  sessions.set(id, session);

  const available = await loadStrategies();

  await Promise.all(strategies.map(async (strategy) => {
    const joinRoom = available[strategy];
    if (!joinRoom) {
      return;
    }

    try {
      // The session may have been closed while the bundle was loading.
      if (!sessions.has(id)) {
        return;
      }

      const room = joinRoom({ appId, password, rtcConfig }, roomId, {
        onJoinError: (details) => post({
          t: 'error',
          id,
          message: `${strategy}: ${details?.error || 'could not join the rendezvous'}`,
        }),
      });
      session.rooms.push(room);

      const action = room.makeAction(ACTION_ID);
      action.onMessage = (data, { peerId }) => {
        // A typed array is passed through as-is rather than rebuilt from its
        // buffer: a view can start partway into a larger allocation, and reading
        // the whole buffer would hand the far end bytes that are not its frame.
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        post({ t: 'data', id, peer: `${strategy}:${peerId}`, b: bytes });
      };

      room.onPeerJoin = (peerId) => {
        const key = `${strategy}:${peerId}`;
        // Sends are chained rather than fired off in parallel. Trystero splits a
        // payload into chunks and resolves when they have drained, so two sends
        // in flight at once interleave their chunks on the wire — and what runs
        // on top of this is a multiplexed byte stream, which needs its frames to
        // arrive whole and in order. Awaiting each send in turn also gives back
        // the backpressure that firing and forgetting throws away.
        let queue = Promise.resolve();
        session.send.set(key, (bytes) => {
          queue = queue
            .then(() => action.send(bytes, { target: peerId }))
            .catch(() => {
              // A failed send means the peer is going away; onPeerLeave reports
              // it, and failing the rest of the queue would hide that.
            });
          return queue;
        });
        session.close.set(key, () => {
          try {
            room.getPeers()[peerId]?.close();
          } catch {
            // Already gone.
          }
        });
        post({ t: 'peer', id, peer: key });
      };

      room.onPeerLeave = (peerId) => {
        const key = `${strategy}:${peerId}`;
        session.send.delete(key);
        session.close.delete(key);
        post({ t: 'gone', id, peer: key });
      };
    } catch (error) {
      post({ t: 'error', id, message: `${strategy}: ${error.message}` });
    }
  }));
}

function leave(id) {
  const session = sessions.get(id);
  if (!session) {
    return;
  }
  sessions.delete(id);
  for (const room of session.rooms) {
    try {
      room.leave();
    } catch {
      // Already gone.
    }
  }
}

function handleMessage(message) {
  switch (message?.t) {
    case 'join':
      join(message).catch((error) => post({ t: 'error', id: message.id, message: error.message }));
      break;
    case 'send': {
      const send = sessions.get(message.id)?.send.get(message.peer);
      send?.(message.b);
      break;
    }
    case 'drop': {
      const session = sessions.get(message.id);
      session?.send.delete(message.peer);
      // Forgetting how to reach the peer is not enough: the far end has a live
      // connection and would sit on a session that never closes. Closing the
      // underlying connection is what tells it to let go.
      session?.close.get(message.peer)?.();
      session?.close.delete(message.peer);
      break;
    }
    case 'leave':
      leave(message.id);
      break;
    default:
      break;
  }
}

ipcRenderer.on('elevenex-rendezvous:port', (event) => {
  [port] = event.ports;
  port.onmessage = (message) => handleMessage(message.data);
  port.start();
});
