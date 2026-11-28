import { once } from 'node:events';
import { desktopRequire } from './common.mjs';

const WebSocket = desktopRequire('ws');

export async function connectPage(target, signal, cleanup) {
  const url = new URL(target.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') {
    throw new Error('Unexpected DevTools WebSocket address');
  }
  const socket = new WebSocket(url, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 5000 });
  cleanup.push(() => socket.terminate());
  const pending = new Map();
  let next = 0;
  socket.on('message', message => {
    const reply = JSON.parse(message);
    const request = pending.get(reply.id);
    if (!request) return;
    if (reply.error) request.reject(new Error(reply.error.message));
    else request.resolve(reply.result);
  });
  socket.on('error', () => socket.terminate());
  socket.on('close', () => {
    for (const request of pending.values()) request.reject(new Error('DevTools page closed'));
  });
  await once(socket, 'open', { signal });
  const command = (method, params = {}) => {
    signal.throwIfAborted();
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('DevTools command timed out: ' + method)), 10000);
      const finish = () => {
        clearTimeout(timer);
        pending.delete(id);
        signal.removeEventListener('abort', abort);
      };
      const fail = error => { finish(); reject(error); };
      const abort = () => fail(signal.reason);
      pending.set(id, { resolve: value => { finish(); resolve(value); }, reject: fail });
      signal.addEventListener('abort', abort, { once: true });
      socket.send(JSON.stringify({ id, method, params }), error => { if (error) fail(error); });
    });
  };
  return {
    command,
    async evaluate(fn, arg) {
      const reply = await command('Runtime.evaluate', {
        expression: '(' + fn.toString() + ')(' + JSON.stringify(arg) + ')',
        returnByValue: true,
        awaitPromise: true,
      });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    },
    async click(x, y) {
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    },
    async key(key, code, windowsVirtualKeyCode, text) {
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    },
  };
}
