/**
 * Minimal RIFF/WAVE reader, for the local Whisper engine.
 *
 * Whisper wants 16 kHz mono `Float32Array`, and the browser already produces
 * exactly that: `blobToWav16kMono` decodes the recording with the Web Audio API
 * — the only decoder guaranteed to understand the codec that same browser just
 * recorded — and sends canonical 16-bit PCM. So this only has to *read* a WAV
 * container, not decode a compressed codec, which is why there is no ffmpeg or
 * audio library on the backend.
 *
 * It stays tolerant of the other shapes a hand-made request might carry
 * (8/24/32-bit, float, stereo, another sample rate) rather than assuming the
 * client's exact output, since reaching the engine with the wrong shape would
 * otherwise surface as garbled audio instead of a clear error.
 */

/** What Whisper's feature extractor expects. */
export const WHISPER_SAMPLE_RATE = 16_000;

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export class WavDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavDecodeError';
  }
}

export interface DecodedWav {
  samples: Float32Array;
  sampleRate: number;
}

/** Decodes to mono `Float32Array` in [-1, 1], resampled to 16 kHz. */
export function decodeWavToMono16k(buffer: Buffer): Float32Array {
  const { samples, sampleRate } = decodeWav(buffer);
  return sampleRate === WHISPER_SAMPLE_RATE
    ? samples
    : resampleLinear(samples, sampleRate, WHISPER_SAMPLE_RATE);
}

export function decodeWav(buffer: Buffer): DecodedWav {
  if (buffer.byteLength < 12) {
    throw new WavDecodeError('The recording is too short to be a WAV file.');
  }
  if (
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new WavDecodeError('The recording is not a WAV file.');
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;

  // Walk the chunk list rather than assuming the canonical 44-byte header:
  // recorders routinely insert LIST/fact chunks before `data`.
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    // A truncated final chunk is common when a recording is cut short; take
    // whatever bytes are actually present instead of rejecting the file.
    const end = Math.min(body + chunkSize, buffer.byteLength);

    if (chunkId === 'fmt ' && end - body >= 16) {
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
      if (format === FORMAT_EXTENSIBLE && end - body >= 26) {
        // WAVE_FORMAT_EXTENSIBLE hides the real format in its GUID's first two
        // bytes; everything else in `fmt ` is already laid out identically.
        format = buffer.readUInt16LE(body + 24);
      }
    } else if (chunkId === 'data') {
      data = buffer.subarray(body, end);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (!data || data.byteLength === 0) {
    throw new WavDecodeError('The recording contains no audio data.');
  }
  if (channels < 1 || sampleRate < 1) {
    throw new WavDecodeError('The recording has an unreadable WAV header.');
  }

  const interleaved = readSamples(data, format, bitsPerSample);
  return { samples: downmixToMono(interleaved, channels), sampleRate };
}

function readSamples(
  data: Buffer,
  format: number,
  bitsPerSample: number,
): Float32Array {
  if (format === FORMAT_FLOAT && bitsPerSample === 32) {
    const count = Math.floor(data.byteLength / 4);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      out[i] = data.readFloatLE(i * 4);
    }
    return out;
  }

  if (format !== FORMAT_PCM) {
    throw new WavDecodeError(
      'Only PCM and 32-bit float WAV recordings are supported.',
    );
  }

  switch (bitsPerSample) {
    case 8: {
      // 8-bit WAV is unsigned, centred on 128 — unlike every wider depth.
      const out = new Float32Array(data.byteLength);
      for (let i = 0; i < out.length; i += 1) {
        out[i] = (data[i]! - 128) / 128;
      }
      return out;
    }
    case 16: {
      const count = Math.floor(data.byteLength / 2);
      const out = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        out[i] = data.readInt16LE(i * 2) / 0x8000;
      }
      return out;
    }
    case 24: {
      const count = Math.floor(data.byteLength / 3);
      const out = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        const at = i * 3;
        // Sign-extend the 24-bit little-endian value into 32 bits.
        const raw =
          (data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16)) << 8;
        out[i] = raw / 0x80000000;
      }
      return out;
    }
    case 32: {
      const count = Math.floor(data.byteLength / 4);
      const out = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        out[i] = data.readInt32LE(i * 4) / 0x80000000;
      }
      return out;
    }
    default:
      throw new WavDecodeError(
        `Unsupported WAV bit depth: ${bitsPerSample || 'unknown'}.`,
      );
  }
}

/** Averages channels, which keeps signal when only one side carries the voice. */
function downmixToMono(
  interleaved: Float32Array,
  channels: number,
): Float32Array {
  if (channels === 1) {
    return interleaved;
  }

  const frames = Math.floor(interleaved.length / channels);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += interleaved[frame * channels + channel]!;
    }
    mono[frame] = sum / channels;
  }
  return mono;
}

/**
 * Matches the client's own resampler. Linear interpolation is enough for speech
 * that a mel spectrogram is about to smooth anyway, and this path only runs for
 * requests that did not already arrive at 16 kHz.
 */
function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const result = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(index + 1, samples.length - 1);
    const weight = position - index;
    result[i] = samples[index]! * (1 - weight) + samples[next]! * weight;
  }
  return result;
}
