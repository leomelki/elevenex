const { spawnSync } = require('child_process');

function isWslCliAvailable() {
  if (process.platform !== 'win32') {
    return false;
  }

  try {
    const result = spawnSync('wsl.exe', ['--status'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return !result.error;
  } catch {
    return false;
  }
}

// wsl.exe prints UTF-16LE to stdout on Windows (even when piped), unlike every
// other tool this app spawns (ssh, node, tmux), which are UTF-8. Decoding as
// UTF-8 here would leave interleaved null bytes and garbled distro names.
function decodeWslOutput(buffer) {
  return buffer.toString('utf16le').replace(/\0/g, '');
}

// Parses `wsl.exe -l -v` output, e.g.:
//   NAME                   STATE           VERSION
// * Ubuntu                 Running         2
//   Debian                 Stopped         1
function parseWslDistroList(raw) {
  return `${raw || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^NAME\b/i.test(line))
    .map((line) => {
      const isDefault = line.startsWith('*');
      const withoutMarker = (isDefault ? line.slice(1) : line).trim();
      const parts = withoutMarker.split(/\s{2,}|\t+/).map((part) => part.trim()).filter(Boolean);
      const name = parts[0] || withoutMarker.split(/\s+/)[0] || '';
      const state = parts[1] || '';
      const wslVersion = Number.parseInt(parts[2], 10) || 1;
      return { name, state, wslVersion, isDefault };
    })
    .filter((distro) => distro.name);
}

function listWslDistros() {
  if (process.platform !== 'win32') {
    return [];
  }

  const result = spawnSync('wsl.exe', ['-l', '-v'], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error || !result.stdout) {
    return [];
  }

  return parseWslDistroList(decodeWslOutput(result.stdout));
}

function getDefaultWslDistro(distros) {
  return distros.find((distro) => distro.isDefault) || distros[0] || null;
}

module.exports = {
  isWslCliAvailable,
  listWslDistros,
  parseWslDistroList,
  getDefaultWslDistro,
};
