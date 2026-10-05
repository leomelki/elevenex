const { readFileSync } = require('node:fs');
const path = require('node:path');

// Preview releases have a separate tag while runtime compatibility remains the
// exact source SHA. Old installations without this marker retain their URL.
function resolveRuntimeReleaseTag(version, resourcesDirectory) {
  if (!version || !/^(?:[a-f0-9]{7,64}|v?\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)$/i.test(version)) {
    return null;
  }
  let tag;
  try {
    tag = readFileSync(path.join(resourcesDirectory, 'release-tag'), 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return `runtime-${version}`;
  }
  if (tag === `runtime-${version}` || (/^runtime-pr-[1-9]\d*-/.test(tag) && tag.replace(/^runtime-pr-[1-9]\d*-/, '') === version)) {
    return tag;
  }
  throw new Error('Bundled release tag does not match the runtime version.');
}

module.exports = { resolveRuntimeReleaseTag };
