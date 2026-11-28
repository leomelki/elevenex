const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { copyFile, mkdir, writeFile } = require('node:fs/promises');
const { basename, join } = require('node:path');

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main([directory, ...files]) {
  if (!directory || !files.length) throw new Error('Usage: stage-release-assets.cjs <directory> <file> [...]');
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    const name = basename(file);
    const destination = join(directory, name);
    await copyFile(file, destination);
    await writeFile(`${destination}.sha256`, `${await sha256(destination)}  ${name}\n`);
  }
}

module.exports = { sha256 };

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
