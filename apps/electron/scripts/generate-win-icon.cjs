// One-off generator: builds a multi-resolution Windows .ico from the square
// Elevenex logo using Electron's nativeImage for high-quality downscaling.
//
// Run with the local Electron binary:
//   node_modules/.bin/electron scripts/generate-win-icon.cjs
//
// Output: assets/icon.ico
const { app, nativeImage } = require('electron');
const { writeFileSync } = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', '..', 'frontend', 'public', 'favicons', 'favicon-512.png');
const OUTPUT = path.join(__dirname, '..', 'assets', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(images) {
  // ICO with PNG-compressed entries (supported on Windows Vista+).
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4); // image count

  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;
  for (let i = 0; i < images.length; i++) {
    const { size, png } = images[i];
    const entry = i * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 0); // width (0 means 256)
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1); // height (0 means 256)
    directory.writeUInt8(0, entry + 2); // palette color count
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // color planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8); // image data size
    directory.writeUInt32LE(offset, entry + 12); // image data offset
    offset += png.length;
  }

  return Buffer.concat([header, directory, ...images.map((img) => img.png)]);
}

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(SOURCE);
  if (source.isEmpty()) {
    console.error('Failed to load source icon:', SOURCE);
    app.exit(1);
    return;
  }

  const images = SIZES.map((size) => ({
    size,
    png: source.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }));

  writeFileSync(OUTPUT, buildIco(images));
  console.log('Wrote', OUTPUT, 'with sizes', SIZES.join(', '));
  app.exit(0);
});
