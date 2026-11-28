const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdirSync, copyFileSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { prepareMacAppCaptureSigning } = require('./task-app-macos-signing.cjs');
const { verifyMacAgentBundle } = require('./verify-task-app-macos.cjs');

// Hash the actual built helper and resources, not the backend revision. Ad hoc
// signatures cannot carry privacy grants across changed code. Giving different
// code the same bundle ID lets Quit and Reopen launch an older, granted copy.
function developmentAgentFingerprint(bundle) {
  const hash = createHash('sha256');
  function visit(relative) {
    for (const entry of readdirSync(join(bundle, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(path).update('\0').update(readFileSync(join(bundle, path))).update('\0');
      else throw new Error('Unexpected link or special file in the built macOS agent');
    }
  }
  visit('');
  return hash.digest('hex').slice(0, 20);
}

/** Build-time only. Never compile or change host permissions during viewer attachment.
 * Writes `Elevenex Agent.app` into `binDirectory`. Runtime archives contain only
 * regular files and directories, so the bundle executable is the sole entry point. */
async function buildMacAppDisplay({ binDirectory }) {
  if (process.platform !== 'darwin') throw new Error('The macOS task app helper requires the Apple SDK');
  const source = resolve(__dirname, '../apps/backend/src/task-apps/native/macos');
  mkdirSync(binDirectory, { recursive: true });
  const bundle = join(binDirectory, 'Elevenex Agent.app');
  rmSync(bundle, { recursive: true, force: true });
  // Remove the former bin/task-app-macos alias left by earlier builds.
  rmSync(join(binDirectory, 'task-app-macos'), { force: true });
  const contents = join(bundle, 'Contents');
  const plist = join(contents, 'Info.plist');
  const resources = join(contents, 'Resources');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(resources);
  copyFileSync(join(source, 'Info.plist'), plist);
  copyFileSync(resolve(__dirname, '../elevenex-logo.svg'), join(resources, 'elevenex-logo.svg'));
  const tokens = readFileSync(resolve(__dirname, '../docs/design-system/project/tokens.css'), 'utf8');
  const palettes = tokens.split('[data-theme="dark"]');
  const palette = section => Object.fromEntries([...section.matchAll(/--([a-z-]+):\s*(#[a-f0-9]{6});/gi)].map(match => [match[1], match[2]]));
  const theme = { light: palette(palettes[0]), dark: palette(palettes[1] || '') };
  for (const mode of ['light', 'dark'])
    for (const token of ['ink', 'ink-muted', 'accent', 'on-accent', 'line', 'line-strong', 'surface', 'surface-raised', 'surface-sunken'])
      if (!theme[mode][token]) throw new Error('Missing native setup token: ' + mode + '/' + token);
  writeFileSync(join(resources, 'AgentTheme.json'), JSON.stringify(theme));
  const executable = join(contents, 'MacOS', 'Elevenex Agent');
  const compile = () => execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang', '-fobjc-arc', '-O2', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    '-mmacosx-version-min=14.0', ...['Main.m', 'DesktopConnection.m', 'Capture.m', 'Setup.m', 'SetupViews.m', 'AgentIcon.m', 'Encoder.m', 'Input.m', 'Supervisor.c'].map(file => join(source, file)),
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit',
    '-framework', 'VideoToolbox', '-framework', 'CoreMedia', '-framework', 'CoreVideo',
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist,
    '-o', executable], { stdio: 'inherit' });
  compile();
  const temporary = mkdtempSync(join(tmpdir(), 'elevenex-agent-icon-'));
  try {
    execFileSync(executable, ['--write-iconset', temporary], { stdio: 'inherit' });
    // Use the repository's ICNS encoder, with AppKit supplying the pixels on
    // headless runtime builders that do not install Electron.
    const { encodeIcns } = await import('./desktop-icons.mjs');
    const entries = [['icp4',16], ['icp5',32], ['icp6',64], ['ic07',128], ['ic08',256], ['ic09',512], ['ic10',1024]];
    writeFileSync(join(resources, 'Agent.icns'), encodeIcns(entries.map(([type, size]) => ({
      type, png: readFileSync(join(temporary, size + '.png')),
    }))));
  } finally { rmSync(temporary,{recursive:true,force:true}); }
  const identity = process.env.ELEVENEX_APP_DISPLAY_SIGN_IDENTITY || '-';
  if (process.env.ELEVENEX_APP_DISPLAY_REQUIRE_SIGNING === '1' && identity === '-')
    throw new Error('Public macOS runtimes require a Developer ID signing identity for Elevenex Agent.');
  let identifier = 'com.elevenex.task-app-display';
  if (identity === '-') {
    const fingerprint = developmentAgentFingerprint(bundle);
    identifier += '.development.' + fingerprint;
    const displayName = 'Elevenex Dev ' + fingerprint.slice(0, 6);
    for (const [key, value] of [['CFBundleIdentifier', identifier], ['CFBundleName', displayName], ['CFBundleDisplayName', displayName]])
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    // Keep the embedded plist and bundle metadata identical for CLI, TCC and
    // LaunchServices. Never weaken the designated requirement to reuse a grant.
    compile();
  }
  const keychain = process.env.ELEVENEX_APP_DISPLAY_KEYCHAIN;
  const signingDirectory = mkdtempSync(join(tmpdir(), 'elevenex-agent-signing-'));
  try {
    const captureArguments = prepareMacAppCaptureSigning({
      contents, directory: signingDirectory, identity,
      profile: process.env.ELEVENEX_APP_DISPLAY_PERSISTENT_CAPTURE_PROFILE,
    });
    execFileSync('/usr/bin/codesign', ['--force', '--options', 'runtime', '--identifier', identifier,
      ...(keychain ? ['--keychain',keychain] : []), ...captureArguments,
      ...(identity === '-' ? [] : ['--timestamp']), '--sign', identity, bundle], { stdio: 'inherit' });
  } finally { rmSync(signingDirectory, { recursive: true, force: true }); }
  // A different certificate class (e.g. Apple Development) cannot share the
  // public privacy identity with Developer ID either. Only ad hoc development
  // or the supported Developer ID distribution identity is accepted here.
  verifyMacAgentBundle(bundle, { release: identity !== '-' });
  const profile = process.env.ELEVENEX_APP_DISPLAY_NOTARY_PROFILE;
  if (process.env.ELEVENEX_APP_DISPLAY_REQUIRE_SIGNING === '1' && !profile)
    throw new Error('Public macOS runtimes require a notary profile for Elevenex Agent.');
  if (profile) {
    const directory = mkdtempSync(join(tmpdir(), 'elevenex-agent-notary-'));
    try {
      const archive = join(directory, 'Elevenex Agent.zip');
      execFileSync('/usr/bin/ditto',['-c','-k','--keepParent',bundle,archive],{stdio:'inherit'});
      execFileSync('/usr/bin/xcrun',['notarytool','submit',archive,'--keychain-profile',profile,
        ...(keychain ? ['--keychain',keychain] : []),'--wait','--timeout','10m'],{stdio:'inherit',timeout:660_000});
      execFileSync('/usr/bin/xcrun',['stapler','staple',bundle],{stdio:'inherit'});
      execFileSync('/usr/bin/xcrun',['stapler','validate',bundle],{stdio:'inherit'});
      execFileSync('/usr/sbin/spctl',['--assess','--type','execute',bundle],{stdio:'inherit'});
    } finally { rmSync(directory,{recursive:true,force:true}); }
  }
  return { bundle, executable };
}

module.exports = { buildMacAppDisplay };
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Specify the output bin directory');
  buildMacAppDisplay({ binDirectory: resolve(process.argv[2]) }).catch(error => { console.error(error); process.exitCode = 1; });
}
