import {
  WavDecodeError,
  decodeWav,
  decodeWavToMono16k,
} from './wav-decode.js';

/**
 * Byte-for-byte the container the frontend's `encodeWav` produces, so these
 * tests exercise the exact bytes the browser sends rather than an idealised
 * WAV.
 */
function encodeWav16(samples: number[], sampleRate = 16_000, channels = 1) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2 * channels, 28);
  buffer.writeUInt16LE(2 * channels, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => {
    buffer.writeInt16LE(sample, 44 + index * 2);
  });
  return buffer;
}

describe('decodeWav', () => {
  it('reads 16-bit PCM back to normalised floats', () => {
    const { samples, sampleRate } = decodeWav(
      encodeWav16([0, 16384, -16384, 32767]),
    );

    expect(sampleRate).toBe(16_000);
    expect(samples.length).toBe(4);
    expect(samples[0]).toBeCloseTo(0, 5);
    expect(samples[1]).toBeCloseTo(0.5, 4);
    expect(samples[2]).toBeCloseTo(-0.5, 4);
    expect(samples[3]).toBeCloseTo(1, 4);
  });

  it('averages channels rather than dropping one', () => {
    // Left silent, right at full scale: taking channel 0 would return silence.
    const { samples } = decodeWav(
      encodeWav16([0, 32767, 0, 32767], 16_000, 2),
    );

    expect(samples.length).toBe(2);
    expect(samples[0]).toBeCloseTo(0.5, 3);
  });

  it('skips chunks between the header and the audio', () => {
    const base = encodeWav16([1000, -1000]);
    const list = Buffer.alloc(8 + 4);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(4, 4);
    list.write('INFO', 8, 'ascii');

    // fmt stays first; LIST is spliced in before `data`, as recorders do.
    const withList = Buffer.concat([
      base.subarray(0, 36),
      list,
      base.subarray(36),
    ]);
    withList.writeUInt32LE(withList.byteLength - 8, 4);

    const { samples } = decodeWav(withList);
    expect(samples.length).toBe(2);
    expect(samples[0]).toBeCloseTo(1000 / 0x8000, 5);
  });

  it('reads a recording whose data chunk was cut short', () => {
    // A stopped-mid-write file declares more bytes than it carries; dropping
    // the audio entirely would lose a dictation that is otherwise fine.
    const truncated = encodeWav16([500, -500, 900]).subarray(0, 44 + 4);
    truncated.writeUInt32LE(6, 40);

    const { samples } = decodeWav(truncated);
    expect(samples.length).toBe(2);
  });

  it('rejects anything that is not a WAV container', () => {
    expect(() => decodeWav(Buffer.from('not audio at all, really'))).toThrow(
      WavDecodeError,
    );
  });

  it('rejects a WAV carrying no audio', () => {
    expect(() => decodeWav(encodeWav16([]))).toThrow(/no audio/i);
  });

  it('names the unsupported bit depth instead of failing opaquely', () => {
    const odd = encodeWav16([1, 2]);
    odd.writeUInt16LE(12, 34);
    expect(() => decodeWav(odd)).toThrow(/bit depth/i);
  });
});

describe('decodeWavToMono16k', () => {
  it('passes 16 kHz audio through untouched', () => {
    const samples = decodeWavToMono16k(encodeWav16([0, 16384, -16384]));
    expect(samples.length).toBe(3);
  });

  it('resamples a higher rate down to what Whisper expects', () => {
    const input = Array.from({ length: 480 }, (_, i) => (i % 2 ? 8000 : -8000));
    const samples = decodeWavToMono16k(encodeWav16(input, 48_000));

    // 48 kHz -> 16 kHz is a third of the frames.
    expect(samples.length).toBe(160);
  });
});
