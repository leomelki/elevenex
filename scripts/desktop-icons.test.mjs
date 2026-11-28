import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { encodeIcns, encodeIco, generateDesktopIcons, iconSvg } from './desktop-icons.mjs';

const assets = new URL('../apps/desktop/assets/icons/', import.meta.url);
const pngSize = png => {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

test('generated assets match their source, generator and integrity manifest', async () => {
  await generateDesktopIcons(undefined, { check: true });
  const source = await readFile(new URL('../elevenex-logo.svg', import.meta.url), 'utf8');
  const svg = await readFile(new URL('icon.svg', assets), 'utf8');
  assert.equal(svg, iconSvg(source));
  for (const path of source.matchAll(/<path[^>]*\/>/g)) assert.ok(svg.includes(path[0]));
  assert.ok(!iconSvg(source, true).includes('<rect'));
  assert.ok(iconSvg(source, true).includes('fill="#000000"'));
  assert.deepEqual(pngSize(await readFile(new URL('trayTemplate.png', assets))), [22, 22]);
  assert.deepEqual(pngSize(await readFile(new URL('trayTemplate@2x.png', assets))), [44, 44]);
});

test('Windows ICO directory addresses each PNG at its actual dimensions', async () => {
  const ico = await readFile(new URL('icon.ico', assets));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 7);
  let end = 6 + 7 * 16;
  for (let index = 0; index < 7; index++) {
    const at = 6 + index * 16;
    const size = ico[at] || 256;
    const length = ico.readUInt32LE(at + 8);
    assert.equal(ico.readUInt32LE(at + 12), end);
    assert.deepEqual(pngSize(ico.subarray(end, end + length)), [size, size]);
    end += length;
  }
  assert.equal(end, ico.length);
  const png = await readFile(new URL('png/256x256.png', assets));
  assert.deepEqual(encodeIco([{ size: 256, png }]).subarray(22), png);
});

test('macOS ICNS includes standard and Retina PNG representations', async () => {
  const icns = await readFile(new URL('icon.icns', assets));
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const expected = new Map([
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
  ]);
  let offset = 8;
  while (offset < icns.length) {
    const type = icns.toString('ascii', offset, offset + 4);
    const length = icns.readUInt32BE(offset + 4);
    const size = expected.get(type);
    assert.ok(size);
    assert.ok(length > 8);
    assert.deepEqual(pngSize(icns.subarray(offset + 8, offset + length)), [size, size]);
    expected.delete(type);
    offset += length;
  }
  assert.equal(expected.size, 0);
  assert.equal(offset, icns.length);
  const png = await readFile(new URL('icon.png', assets));
  assert.deepEqual(encodeIcns([{ type: 'ic09', png }]).subarray(16), png);
});

test('packaging includes runtime images and uses generated platform/installer icons', async () => {
  const config = JSON.parse(await readFile(new URL('../apps/desktop/electron-builder.json', import.meta.url), 'utf8'));
  assert.equal(config.mac.icon, 'assets/icons/icon.icns');
  assert.equal(config.win.icon, 'assets/icons/icon.ico');
  assert.equal(config.linux.icon, 'assets/icons/png');
  assert.equal(config.nsis.installerIcon, config.win.icon);
  assert.equal(config.nsis.uninstallerIcon, config.win.icon);
  assert.equal(config.dmg.icon, config.mac.icon);
  assert.ok(config.files.includes('assets/icons/icon.png'));
  assert.ok(config.files.includes('assets/icons/tray*.png'));
});
