// Runs in the hidden renderer created by link-webrtc.cjs.
//
// All of the WebRTC work happens here rather than in page script: a preload has
// access to the page's web APIs (RTCPeerConnection included) while the page
// itself stays about:blank, so there is no HTML to ship and no page code to
// load. The main process talks to this over a MessagePort, keyed by peer id.

'use strict';

const { ipcRenderer } = require('electron');

// Chromium negotiates SCTP fragmentation with itself happily, but keeping
// messages modest bounds how much a single send can park in the outgoing
// buffer. The mux above is configured to stay under this.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const BUFFERED_LOW_THRESHOLD = 512 * 1024;

const peers = new Map();
let port = null;

function post(message) {
  if (!port) {
    return;
  }
  try {
    port.postMessage(message);
  } catch {
    // The port closed while we were answering; the peer teardown follows.
  }
}

function destroyPeer(id, { notify }) {
  const peer = peers.get(id);
  if (!peer) {
    return;
  }
  peers.delete(id);
  try {
    peer.channel?.close();
  } catch {
    // Already closed.
  }
  try {
    peer.connection.close();
  } catch {
    // Already closed.
  }
  if (notify) {
    post({ t: 'close', id });
  }
}

function attachDataChannel(peer, channel) {
  peer.channel = channel;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = BUFFERED_LOW_THRESHOLD;

  channel.onopen = () => post({ t: 'open', id: peer.id });
  channel.onmessage = (event) => {
    post({ t: 'data', id: peer.id, b: new Uint8Array(event.data) });
  };
  channel.onerror = () => {
    // 'error' on a data channel is almost always followed by a close; report it
    // once and let the close path do the teardown.
    post({ t: 'error', id: peer.id, message: 'The direct connection failed.' });
  };
  channel.onclose = () => destroyPeer(peer.id, { notify: true });
  channel.onbufferedamountlow = () => flush(peer);
}

// Queue rather than drop when the channel is congested. The mux's own per-stream
// windows bound how much can pile up here.
function flush(peer) {
  while (peer.queue.length > 0) {
    if (peer.channel.bufferedAmount > MAX_BUFFERED_BYTES) {
      return;
    }
    const next = peer.queue.shift();
    try {
      peer.channel.send(next);
    } catch (error) {
      post({ t: 'error', id: peer.id, message: error?.message || 'send failed' });
      destroyPeer(peer.id, { notify: true });
      return;
    }
  }
}

function createPeer({ id, initiator, iceServers }) {
  const connection = new RTCPeerConnection({ iceServers: iceServers || [] });
  const peer = { id, connection, channel: null, queue: [], remoteDescriptionSet: false, pendingCandidates: [] };
  peers.set(id, peer);

  connection.onicecandidate = (event) => {
    if (event.candidate) {
      post({ t: 'signal', id, payload: { candidate: event.candidate.toJSON() } });
    }
  };

  connection.onconnectionstatechange = () => {
    const state = connection.connectionState;
    if (state === 'failed' || state === 'closed') {
      destroyPeer(id, { notify: true });
    }
  };

  if (initiator) {
    // Ordered and reliable: the mux above assumes both, exactly as it does on a
    // WebSocket or a TCP socket.
    attachDataChannel(peer, connection.createDataChannel('elevenex', { ordered: true }));
    connection
      .createOffer()
      .then((offer) => connection.setLocalDescription(offer).then(() => offer))
      .then((offer) => post({ t: 'signal', id, payload: { sdp: { type: offer.type, sdp: offer.sdp } } }))
      .catch((error) => post({ t: 'error', id, message: error?.message || 'offer failed' }));
  } else {
    connection.ondatachannel = (event) => attachDataChannel(peer, event.channel);
  }
}

async function applySignal(peer, payload) {
  const { connection } = peer;

  if (payload.sdp) {
    await connection.setRemoteDescription(payload.sdp);
    peer.remoteDescriptionSet = true;
    // Candidates that arrived before the description could not be added yet.
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await connection.addIceCandidate(candidate).catch(() => {});
    }
    if (payload.sdp.type === 'offer') {
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      post({ t: 'signal', id: peer.id, payload: { sdp: { type: answer.type, sdp: answer.sdp } } });
    }
    return;
  }

  if (payload.candidate) {
    if (!peer.remoteDescriptionSet) {
      peer.pendingCandidates.push(payload.candidate);
      return;
    }
    await connection.addIceCandidate(payload.candidate).catch(() => {});
  }
}

function handleMessage(message) {
  if (message?.t === 'create') {
    createPeer(message);
    return;
  }

  const peer = peers.get(message?.id);
  if (!peer) {
    return;
  }

  switch (message.t) {
    case 'signal':
      applySignal(peer, message.payload).catch((error) => {
        post({ t: 'error', id: peer.id, message: error?.message || 'signal failed' });
        destroyPeer(peer.id, { notify: true });
      });
      break;
    case 'send':
      peer.queue.push(message.b);
      if (peer.channel && peer.channel.readyState === 'open') {
        flush(peer);
      }
      break;
    case 'destroy':
      destroyPeer(peer.id, { notify: false });
      break;
    default:
      break;
  }
}

ipcRenderer.on('elevenex-webrtc:port', (event) => {
  [port] = event.ports;
  port.onmessage = (message) => handleMessage(message.data);
  port.start();
});
