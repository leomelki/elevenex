import { once } from 'node:events';
import { connect, createServer } from 'node:net';

/** Add propagation delay in each direction without sleeping between chunks.
 * The queue is bounded and both TCP half-closes are preserved. */
function delayBytes(source, destination, milliseconds, kbps) {
  const queue = [];
  let timer, blocked = false, ended = false;
  let serializedAt = 0;
  const flush = () => {
    timer = undefined;
    while (!blocked && !destination.destroyed && queue.length) {
      const remaining = queue[0].at - performance.now();
      if (remaining > 0) {
        timer = setTimeout(flush, Math.ceil(remaining));
        break;
      }
      blocked = !destination.write(queue.shift().data);
    }
    if (!blocked && queue.length < 8 && !source.destroyed) source.resume();
    if (ended && !queue.length && !destination.destroyed) destination.end();
  };
  source.on('data', data => {
    const now = performance.now();
    if (kbps) {
      for (let offset = 0; offset < data.length; offset += 8192) {
        const chunk = data.subarray(offset, offset + 8192);
        serializedAt = Math.max(now, serializedAt) + chunk.length * 8 / kbps;
        queue.push({ data: chunk, at: serializedAt + milliseconds });
      }
    } else {
      queue.push({ data, at: now + milliseconds });
    }
    if (queue.length >= 16) source.pause();
    if (!timer && !blocked) flush();
  });
  source.on('end', () => { ended = true; if (!timer && !blocked) flush(); });
  destination.on('drain', () => { blocked = false; if (!timer) flush(); });
  destination.once('close', () => { clearTimeout(timer); source.destroy(); });
}

export async function startDelayRelay(targetPort, rttMs, kbps) {
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, local => {
    const remote = connect({ host: '127.0.0.1', port: targetPort, allowHalfOpen: true });
    for (const socket of [local, remote]) {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => sockets.delete(socket));
    }
    delayBytes(local, remote, rttMs / 2);
    delayBytes(remote, local, rttMs / 2, kbps);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
