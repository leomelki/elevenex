/**
 * Which machines can run the offline engine.
 *
 * ONNX Runtime publishes one npm package carrying a prebuilt addon per
 * platform/arch. There is no source build to fall back on, so an unlisted
 * combination cannot run Whisper locally no matter what else is installed —
 * and finding that out by `require`-ing the addon produces a linker error that
 * means nothing to a user. Checking first lets the UI say something true.
 *
 * Keep in step with `onnxruntime-node`'s `bin/napi-v6/<platform>/<arch>`
 * directories; `scripts/archive-electron-backend.js` asserts the host's own
 * entry exists at packaging time.
 */
const SUPPORTED_TARGETS = new Set([
  'darwin/arm64',
  'linux/arm64',
  'linux/x64',
  'win32/arm64',
  'win32/x64',
]);

export function isSupportedWhisperPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return SUPPORTED_TARGETS.has(`${platform}/${arch}`);
}

/**
 * A message for a machine that cannot run the engine, or `null` when it can.
 * Always names the alternative — the cloud providers work everywhere, so an
 * unsupported machine is never a dead end.
 */
export function describeUnsupportedPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (isSupportedWhisperPlatform(platform, arch)) {
    return null;
  }

  if (platform === 'darwin' && arch === 'x64') {
    // Dropped upstream after onnxruntime-node 1.23.2.
    return 'Offline dictation needs an Apple silicon Mac — ONNX Runtime no longer ships an Intel macOS build. Pick one of the online services instead.';
  }

  return `Offline dictation is not available on ${platform}/${arch}, which ONNX Runtime has no build for. Pick one of the online services instead.`;
}
