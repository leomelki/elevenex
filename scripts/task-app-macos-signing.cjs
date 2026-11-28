const { execFileSync, spawnSync } = require('node:child_process');
const { copyFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const persistentCapture = 'com.apple.developer.persistent-content-capture';
const applicationIdentifier = 'com.apple.application-identifier';
const teamIdentifier = 'com.apple.developer.team-identifier';

// Build-time only. A restricted entitlement needs Apple's approved profile;
// claiming it on an ad hoc development build can prevent the agent launching.
function prepareMacAppCaptureSigning({ contents, directory, identity, profile }) {
  if (!profile) return [];
  if (!identity || identity === '-')
    throw new Error('Persistent content capture requires a Developer ID signing identity.');
  const embedded = join(directory, 'embedded.provisionprofile');
  // Validate the same bytes that will be embedded, even if the source changes.
  copyFileSync(resolve(profile), embedded);
  const decoded = join(directory, 'profile.plist');
  const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 };
  execFileSync('/usr/bin/security', ['cms', '-D', '-i', embedded, '-o', decoded], options);
  // A profile may contain plist dates and binary data that plutil cannot emit
  // as JSON. Read only the typed values needed to authorize signing.
  const extract = (keyPath, type) => {
    const result = spawnSync('/usr/bin/plutil', ['-extract', keyPath, 'raw', '-expect', type, '-n', '-o', '-', decoded], options);
    if (result.error) throw result.error;
    return result.status === 0 ? result.stdout : undefined;
  };
  const entitlementPath = key => `Entitlements.${key.replaceAll('.', '\\.')}`;
  if (extract(entitlementPath(persistentCapture), 'bool') !== 'true')
    throw new Error('The provisioning profile does not authorize persistent content capture. Request approval from Apple first.');
  const team = extract(entitlementPath(teamIdentifier), 'string');
  const application = extract(entitlementPath(applicationIdentifier), 'string');
  if (!team || !application || !/^[^.]+\.com\.elevenex\.task-app-display$/.test(application))
    throw new Error('Persistent content capture requires a profile for com.elevenex.task-app-display with a team identifier.');
  if (extract('ProvisionsAllDevices', 'bool') !== 'true')
    throw new Error('Persistent content capture requires a Developer ID distribution profile.');
  const expiration = Date.parse(extract('ExpirationDate', 'date') ?? '');
  if (!Number.isFinite(expiration) || expiration <= Date.now())
    throw new Error('The persistent content capture provisioning profile has expired or has no valid expiration.');
  const entitlementFile = join(directory, 'capture-entitlements.plist');
  // Do not inherit unrelated capabilities (such as get-task-allow) from the
  // profile allowlist. Claim only capture and its required signing identity.
  const claims = {
    [persistentCapture]: true,
    [applicationIdentifier]: application,
    [teamIdentifier]: team,
  };
  writeFileSync(entitlementFile, execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], {
    ...options, input: JSON.stringify(claims),
  }));
  copyFileSync(embedded, join(contents, 'embedded.provisionprofile'));
  return ['--entitlements', entitlementFile, '--generate-entitlement-der'];
}

module.exports = { prepareMacAppCaptureSigning };
