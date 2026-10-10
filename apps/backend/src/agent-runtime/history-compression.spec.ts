import express from 'express';
import { createServer, get, type IncomingHttpHeaders, type Server } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createHistoryCompression } from './history-compression.js';

const historyPath = '/api/sessions/123/agents/codex/history';
const payload = JSON.stringify({ messages: Array.from({ length: 500 }, (_, i) => ({
  id: String(i), content: `tool output ${i}: ${'a large transcript line\n'.repeat(50)}`,
})) });

describe('history compression', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const app = express();
    app.use(createHistoryCompression());
    app.get('/api/sessions/:id/agents/:provider/*path', (req, res) => {
      res.type('json').send(req.path.endsWith('/small') ? '{"messages":[]}' : payload);
    });
    app.get('/api/events', (_req, res) => res.type('text/event-stream').send(`data: ${payload}\n\n`));
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function request(path: string, encoding?: string): Promise<{ body: Buffer; headers: IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      get(`${origin}${path}`, { headers: encoding ? { 'Accept-Encoding': encoding } : {} }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ body: Buffer.concat(chunks), headers: res.headers }));
      }).on('error', reject);
    });
  }

  it.each([historyPath, `${historyPath}?refresh=1`, '/api/sessions/123/agents/claude/snapshot', '/api/sessions/123/agents/claude/subagents/task/history'])(
    'compresses large transcripts without changing their JSON at %s', async path => {
      const { body, headers } = await request(path, 'gzip');
      expect(headers['content-encoding']).toBe('gzip');
      expect(headers.vary).toContain('Accept-Encoding');
      expect(headers['content-length']).toBeUndefined();
      expect(gunzipSync(body).toString()).toBe(payload);
      expect(body.length).toBeLessThan(Buffer.byteLength(payload) / 5);
    },
  );

  it('supports browser Brotli negotiation', async () => {
    const { body, headers } = await request(historyPath, 'br');
    expect(headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(body).toString()).toBe(payload);
  });

  it.each([undefined, 'identity', 'gzip;q=0, br;q=0, deflate;q=0'])('preserves plain responses when compression is not accepted (%s)', async encoding => {
    const { body, headers } = await request(historyPath, encoding);
    expect(headers['content-encoding']).toBeUndefined();
    expect(body.toString()).toBe(payload);
  });

  it('does not compress unrelated APIs or streaming events', async () => {
    const { headers } = await request('/api/events', 'gzip');
    expect(headers['content-encoding']).toBeUndefined();
    const other = await request('/api/sessions/123/agents/codex/runtime-state', 'gzip');
    expect(other.headers['content-encoding']).toBeUndefined();
  });
});
