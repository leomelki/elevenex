import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Keep the traced paths intact; only their container, padding and tray fill vary. */
export function iconSvg(source, tray = false) {
  const logo = source.trim().replace('<svg ', `<svg x="${tray ? 1 : 190}" y="${tray ? 4.85 : 314}" width="${tray ? 20 : 644}" height="${tray ? 12.3 : 396}" `);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${tray ? '22 22' : '1024 1024'}">${tray ? '' : '<rect x="64" y="64" width="896" height="896" rx="200" fill="#0e0e0d"/>'}${tray ? logo.replace(/fill="[^"]*"/g, 'fill="#000000"') : logo}</svg>\n`;
}

/** Windows supports PNG-compressed ICO entries, including the 256px entry. */
export function encodeIco(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  for (const [index, { size, png }] of entries.entries()) {
    const at = 6 + index * 16;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries.map(entry => entry.png)]);
}

/** Modern ICNS chunks contain PNGs; Retina chunks keep their logical identity. */
export function encodeIcns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write('icns');
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

export async function generateDesktopIcons(root = projectRoot, { force = false, check = false } = {}) {
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  const source = await readFile(join(root, 'elevenex-logo.svg'), 'utf8');
  const fingerprint = digest(Buffer.concat([
    Buffer.from(source), await readFile(fileURLToPath(import.meta.url)),
    await readFile(join(root, 'scripts/desktop-icons-render.cjs')),
    Buffer.from(require('electron/package.json').version),
  ]));
  const manifestPath = join(root, 'apps/desktop/assets/icons/manifest.json');
  const previous = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null);
  if (!force && previous?.fingerprint === fingerprint && Object.keys(previous.files).length > 0) {
    const matches = await Promise.all(Object.entries(previous.files).map(async ([path, hash]) =>
      digest(await readFile(join(root, path)).catch(() => Buffer.alloc(0))) === hash));
    if (matches.every(Boolean)) return;
  }
  if (check) throw new Error('Desktop icons are stale or missing. Run pnpm desktop:icons.');
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'elevenex-icons-')));
  try {
    const config = join(temporary, 'config.json');
    await writeFile(config, JSON.stringify({ root, source, temporary }));
    const env = { ...process.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    await new Promise((resolve, reject) => {
      // Select the profile before Chromium initializes network-service sandbox paths.
      const child = spawn(require('electron'), [join(root, 'scripts/desktop-icons-render.cjs'), config, `--user-data-dir=${temporary}`], {
        cwd: root, env, stdio: 'inherit', timeout: 60_000,
      });
      const stop = () => { child.kill('SIGTERM'); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      child.once('close', () => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Icon renderer exited with ${signal ?? code}`)));
    });
    const paths = JSON.parse(await readFile(join(temporary, 'outputs.json'), 'utf8'));
    const files = Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, digest(await readFile(join(root, path)))])));
    await mkdir(join(root, 'apps/desktop/assets/icons'), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({ source: 'elevenex-logo.svg', fingerprint, files }, null, 2)}\n`);
    console.log(`Generated ${paths.length} desktop icon assets from elevenex-logo.svg`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--force', '--check'].includes(arg)) || args.includes('--force') && args.includes('--check')) {
    throw new Error('Use desktop:icons [--force | --check]');
  }
  await generateDesktopIcons(projectRoot, { force: args.includes('--force'), check: args.includes('--check') });
}
