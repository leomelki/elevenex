const { execFileSync } = require('node:child_process');
const { mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { prepareMacAppCaptureSigning } = require('./task-app-macos-signing.cjs');

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
  const resources = join(contents, 'Resources');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(resources);
  copyFileSync(join(source, 'Info.plist'), join(contents, 'Info.plist'));
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
  execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang', '-fobjc-arc', '-O2', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    '-mmacosx-version-min=14.0', ...['Main.m', 'DesktopConnection.m', 'Capture.m', 'Setup.m', 'SetupViews.m', 'AgentIcon.m', 'Encoder.m', 'Input.m', 'Supervisor.c'].map(file => join(source, file)),
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit',
    '-framework', 'VideoToolbox', '-framework', 'CoreMedia', '-framework', 'CoreVideo',
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', join(source, 'Info.plist'),
    '-o', executable], { stdio: 'inherit' });
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
  const keychain = process.env.ELEVENEX_APP_DISPLAY_KEYCHAIN;
  const signingDirectory = mkdtempSync(join(tmpdir(), 'elevenex-agent-signing-'));
  try {
    const captureArguments = prepareMacAppCaptureSigning({
      contents, directory: signingDirectory, identity,
      profile: process.env.ELEVENEX_APP_DISPLAY_PERSISTENT_CAPTURE_PROFILE,
    });
    execFileSync('/usr/bin/codesign', ['--force', '--options', 'runtime', '--identifier', 'com.elevenex.task-app-display',
      ...(keychain ? ['--keychain',keychain] : []), ...captureArguments,
      ...(identity === '-' ? [] : ['--timestamp']), '--sign', identity, bundle], { stdio: 'inherit' });
  } finally { rmSync(signingDirectory, { recursive: true, force: true }); }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
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
