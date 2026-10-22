import { createRequire } from 'node:module';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function responseStatus(url, timeout) {
  // Readiness needs headers only. Consume the body and bound the request lifetime;
  // using node:http also avoids platform-specific failures in Node's fetch client.
  return new Promise((resolveResponse, reject) => {
    const request = get(url, { timeout }, response => {
      response.resume();
      resolveResponse(response.statusCode ?? 0);
    });
    request.once('timeout', () => request.destroy(new Error('Renderer readiness request timed out')));
    request.once('error', reject);
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

export async function prepareRenderer(root, options, processes) {
  const renderer = join(root, 'apps/renderer');
  const rendererRequire = createRequire(join(renderer, 'package.json'));
  if (options.built) return { url: undefined };
  if (options.url) {
    const status = await responseStatus(options.url, 3000);
    if (status < 200 || status >= 300) throw new Error(`Renderer returned HTTP ${status}`);
    return { url: options.url };
  }
  if (!options.fixture) {
    await access(join(renderer, 'src/main.ts')).catch(() => { throw new Error('The product renderer has no src/main.ts yet. Use --fixture to verify the capture tool, or supply --url when the shell is available.'); });
    // Match desktop:dev: use only the authoritative source, never invent tokens.
    const tokens = await readFile(join(root, 'docs/design-system/project/tokens.css'));
    await mkdir(join(renderer, 'src/design-system'), { recursive: true });
    await writeFile(join(renderer, 'src/design-system/tokens.css'), tokens);
  }
  const port = options.port ?? await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const target = options.fixture ? 'renderer:build:capture-fixture' : 'renderer:build:development';
  const server = processes.start(process.execPath, [rendererRequire.resolve('@angular/cli/bin/ng.js'), 'serve', '--build-target', target, '--host', '127.0.0.1', '--port', String(port)], renderer);
  for (let attempt = 0; attempt < 300; attempt++) {
    if (processes.stopped || server.child.exitCode !== null || server.child.signalCode !== null) throw new Error('Angular stopped before becoming ready');
    let status;
    try {
      status = await responseStatus(url, 500);
    } catch { /* Initial Angular compilation. */ }
    if (status >= 200 && status < 300) {
      console.log(`CAPTURE_RENDERER_URL=${url}`);
      return { url, done: server.done };
    }
    await delay(100);
  }
  throw new Error('Angular did not become ready; inspect the build diagnostics above');
}
