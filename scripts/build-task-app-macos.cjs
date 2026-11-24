const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

/** Build-time only. Never compile or change host permissions during viewer attachment. */
function buildMacAppDisplay({ outputPath }) {
  if (process.platform !== 'darwin') throw new Error('The macOS task app helper requires the Apple SDK');
  const source = resolve(__dirname, '../apps/backend/src/task-apps/native/macos');
  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang', '-fobjc-arc', '-O2', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    '-mmacosx-version-min=14.0', ...['Main.m', 'Encoder.m', 'Input.m', 'Supervisor.c'].map(file => join(source, file)),
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit',
    '-framework', 'VideoToolbox', '-framework', 'CoreMedia', '-framework', 'CoreVideo',
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', join(source, 'Info.plist'),
    '-o', outputPath], { stdio: 'inherit' });
  const identity = process.env.ELEVENEX_APP_DISPLAY_SIGN_IDENTITY || '-';
  execFileSync('/usr/bin/codesign', ['--force', '--options', 'runtime', '--identifier', 'com.elevenex.task-app-display',
    ...(identity === '-' ? [] : ['--timestamp']), '--sign', identity, outputPath], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', outputPath], { stdio: 'inherit' });
}

module.exports = { buildMacAppDisplay };
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Specify the output executable path');
  buildMacAppDisplay({ outputPath: resolve(process.argv[2]) });
}
