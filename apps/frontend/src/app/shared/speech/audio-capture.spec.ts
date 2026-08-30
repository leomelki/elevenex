import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRecordingSupported, pickMimeType } from './audio-capture';

const originalMediaRecorder = globalThis.MediaRecorder;
const originalNavigator = globalThis.navigator;

function stubMediaRecorder(supported: string[]): void {
  const stub = vi.fn() as unknown as typeof MediaRecorder;
  (stub as unknown as { isTypeSupported: (t: string) => boolean }).isTypeSupported =
    (type: string) => supported.includes(type);
  globalThis.MediaRecorder = stub;
}

afterEach(() => {
  globalThis.MediaRecorder = originalMediaRecorder;
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    configurable: true,
  });
});

describe('pickMimeType', () => {
  it('prefers opus in webm, the smallest widely supported option', () => {
    stubMediaRecorder(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']);
    expect(pickMimeType()).toBe('audio/webm;codecs=opus');
  });

  it('falls back through the list when webm is unavailable', () => {
    // Safari's shape: no webm at all.
    stubMediaRecorder(['audio/mp4']);
    expect(pickMimeType()).toBe('audio/mp4');
  });

  it('falls back to ogg/opus before mp4', () => {
    stubMediaRecorder(['audio/ogg;codecs=opus', 'audio/mp4']);
    expect(pickMimeType()).toBe('audio/ogg;codecs=opus');
  });

  it('returns null when nothing in the list is supported', () => {
    stubMediaRecorder(['audio/aiff']);
    expect(pickMimeType()).toBeNull();
  });

  it('returns null when MediaRecorder does not exist', () => {
    // @ts-expect-error deliberately removing the global for this case
    globalThis.MediaRecorder = undefined;
    expect(pickMimeType()).toBeNull();
  });
});

describe('isRecordingSupported', () => {
  it('is false without getUserMedia even when a codec is available', () => {
    stubMediaRecorder(['audio/webm;codecs=opus']);
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: undefined },
      configurable: true,
    });
    expect(isRecordingSupported()).toBe(false);
  });

  it('is false when getUserMedia exists but no codec does', () => {
    stubMediaRecorder([]);
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: vi.fn() } },
      configurable: true,
    });
    expect(isRecordingSupported()).toBe(false);
  });

  it('is true when both are available', () => {
    stubMediaRecorder(['audio/webm;codecs=opus']);
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: vi.fn() } },
      configurable: true,
    });
    expect(isRecordingSupported()).toBe(true);
  });
});
