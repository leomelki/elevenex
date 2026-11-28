const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { Response } = globalThis;

const version = 'a'.repeat(40);

function tar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 8);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1);
    header.write('ustar\0', 257, 6);
    const sum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

function archive(extra = []) {
  return tar([
    { name: 'backend/main.cjs', body: 'console.log("backend");' },
    { name: 'backend/node/bin/node', body: 'node executable', mode: 0o755 },
    { name: 'backend/node/node.exe', body: 'windows node executable' },
    ...extra,
  ]);
}

function releaseFetch(release, bytes = archive(), options = {}) {
  const calls = [];
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const request = async (url, init) => {
    calls.push(String(url));
    init.signal.throwIfAborted();
    if (String(url).endsWith('.sha256')) {
      return new Response(`${options.checksum ?? checksum}  ${release.archiveName}\n`);
    }
    return new Response(bytes, { status: options.status ?? 200, headers: { 'content-length': String(bytes.length) } });
  };
  return { request, calls };
}

module.exports = { tar, archive, releaseFetch, version };
