import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The same immutable bridge, including its pure dependencies, runs on each remote OS. */
export async function remoteClientSources() {
  // The uploaded bridge needs only the pure address validator, not the SOCKS server.
  const modules = ['wire', 'runtime', 'runtime-control', 'runtime-start', 'runtime-handoff', 'windows-runtime', 'windows-pipe', 'agent-proxy', 'host', 'process-tree', 'browser-destination', 'node_modules/@elevenex/browser-network/dist/public-address'];
  const sources = await Promise.all(modules.map(name => {
    const path = name.startsWith('node_modules/')
      ? require.resolve('@elevenex/browser-network/dist/public-address')
      : join(__dirname, name === 'host' || name === 'process-tree' ? `../backend/${name}.js` : `${name}.js`);
    return readFile(path, 'utf8');
  }));
  const clientId = createHash('sha256').update(sources.join('\n')).digest('hex');
  return { modules, sources, clientId };
}
