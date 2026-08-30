import {
  describeUnsupportedPlatform,
  isSupportedWhisperPlatform,
} from './whisper-platform.js';

describe('whisper platform support', () => {
  it.each([
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
  ])('accepts %s/%s, which ONNX Runtime ships an addon for', (platform, arch) => {
    expect(isSupportedWhisperPlatform(platform, arch)).toBe(true);
    expect(describeUnsupportedPlatform(platform, arch)).toBeNull();
  });

  it('rejects Intel macOS and says why, naming the alternative', () => {
    // onnxruntime-node stopped publishing darwin/x64 after 1.23.2, so this is
    // a permanent gap rather than a missing install step.
    expect(isSupportedWhisperPlatform('darwin', 'x64')).toBe(false);

    const message = describeUnsupportedPlatform('darwin', 'x64');
    expect(message).toMatch(/Apple silicon/i);
    expect(message).toMatch(/online services/i);
  });

  it('names an unknown platform rather than failing silently', () => {
    const message = describeUnsupportedPlatform('freebsd', 'x64');
    expect(message).toContain('freebsd/x64');
    expect(message).toMatch(/online services/i);
  });

  it('describes the machine it is actually running on', () => {
    // Guards against a typo in the table making every real host unsupported.
    expect(isSupportedWhisperPlatform()).toBe(
      isSupportedWhisperPlatform(process.platform, process.arch),
    );
  });
});
