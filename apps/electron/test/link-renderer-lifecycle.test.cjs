const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { it } = require('node:test');

function loadFactory(filename) {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.postMessage = () => {};
      this.destroyed = false;
      windows.push(this);
    }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  class MessageChannelMain {
    constructor() {
      this.port1 = new EventEmitter();
      this.port1.postMessage = () => {};
      this.port1.start = () => {};
      this.port2 = {};
    }
  }
  const context = vm.createContext({
    module: { exports: {} },
    __dirname: path.join(__dirname, '..'),
    Buffer, process,
    require: name => name === 'electron' ? { MessageChannelMain } : require(name.startsWith('.') ? path.join(__dirname, '..', name) : name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context);
  return { exports: context.module.exports, BrowserWindow, windows };
}

it('retires rooms and recreates their renderer after a crash', () => {
  const { exports, BrowserWindow, windows } = loadFactory('link-rendezvous.cjs');
  const open = exports.createRendezvousFactory({ BrowserWindow });
  const room = open({ pairingKey: Buffer.alloc(32) });
  room.addPeer('remote');
  const peer = room.peers.get('remote');
  let closed = false;
  room.on('close', () => { closed = true; });
  windows[0].webContents.emit('render-process-gone');
  assert.equal(closed, true);
  assert.equal(peer.closed, true);
  const replacement = open({ pairingKey: Buffer.alloc(32) });
  assert.equal(windows.length, 2);
  assert.equal(replacement.closed, false);
  replacement.close();
});

it('allows a rendezvous peer to return under the same id after being retired', () => {
  const { exports, BrowserWindow } = loadFactory('link-rendezvous.cjs');
  const room = exports.createRendezvousFactory({ BrowserWindow })({ pairingKey: Buffer.alloc(32) });
  room.addPeer('remote');
  const previous = room.peers.get('remote');
  previous.close();
  room.addPeer('remote');
  assert.notEqual(room.peers.get('remote'), previous);
  assert.equal(room.peers.get('remote').closed, false);
  room.close();
});

it('closes WebRTC peers and creates a fresh renderer after a crash', () => {
  const { exports, BrowserWindow, windows } = loadFactory('link-webrtc.cjs');
  const create = exports.createWebRtcPeerFactory({ BrowserWindow });
  const peer = create({ initiator: true });
  windows[0].webContents.emit('render-process-gone');
  assert.equal(peer.closed, true);
  const replacement = create({ initiator: true });
  assert.equal(windows.length, 2);
  assert.equal(replacement.closed, false);
  replacement.close();
});

it('retires a P2P peer after a failed send and discards its queued frames', async () => {
  let attach;
  let sends = 0;
  let closes = 0;
  const messages = [];
  const room = {
    makeAction: () => ({ send: async () => { ++sends; throw new Error('carrier failed'); } }),
    getPeers: () => ({ remote: { close: () => { ++closes; } } }),
    leave: () => {},
  };
  class RTCPeerConnection { setLocalDescription() {} }
  const context = vm.createContext({
    __dirname: path.join(__dirname, '..'),
    RTCPeerConnection,
    require: name => name === 'electron' ? { ipcRenderer: { on: (_event, callback) => { attach = callback; } } } : require(name),
    fakeRoom: room,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'link-rendezvous-preload.cjs'), 'utf8'), context);
  vm.runInContext('loadStrategies = async () => ({ nostr: () => fakeRoom });', context);
  const port = { postMessage: message => messages.push(message), start: () => {} };
  attach({ ports: [port] });
  port.onmessage({ data: { t: 'join', id: 1, strategies: ['nostr'] } });
  await new Promise(resolve => setImmediate(resolve));
  room.onPeerJoin('remote');
  port.onmessage({ data: { t: 'send', id: 1, peer: 'nostr:remote', b: new Uint8Array([1]) } });
  port.onmessage({ data: { t: 'send', id: 1, peer: 'nostr:remote', b: new Uint8Array([2]) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1);
  assert.equal(closes, 1);
  assert.equal(messages.filter(message => message.t === 'gone').length, 1);
  port.onmessage({ data: { t: 'leave', id: 1 } });
});
