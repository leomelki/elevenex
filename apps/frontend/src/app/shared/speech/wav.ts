/**
 * WAV transcoding for the one STT route that cannot take the browser's native
 * recording: OpenRouter, whose chat `input_audio` part documents wav/mp3/aiff/
 * aac/ogg/flac/m4a/pcm16/pcm24 — but not webm, which is exactly what Chromium's
 * `MediaRecorder` produces.
 *
 * The decode step is the browser's own: `decodeAudioData` handles the webm/opus
 * (Chromium) or mp4/aac (Safari) that the *same* browser just recorded, so
 * there is no codec library and no ffmpeg here.
 */

/** Speech models resample to this anyway; sending it saves ~6x the bytes. */
export const TARGET_SAMPLE_RATE = 16_000;

export const WAV_MIME_TYPE = 'audio/wav';

export async function blobToWav16kMono(blob: Blob): Promise<Blob> {
  const audioBuffer = await decode(await blob.arrayBuffer());
  const mono = downmixToMono(audioBuffer);
  const resampled = resampleLinear(
    mono,
    audioBuffer.sampleRate,
    TARGET_SAMPLE_RATE,
  );
  return new Blob([encodeWav(resampled, TARGET_SAMPLE_RATE)], {
    type: WAV_MIME_TYPE,
  });
}

async function decode(data: ArrayBuffer): Promise<AudioBuffer> {
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('This browser cannot decode audio.');
  }

  const context = new AudioContextCtor();
  try {
    // The callback form is passed too: Safari long refused to return a promise.
    return await new Promise<AudioBuffer>((resolve, reject) => {
      void context.decodeAudioData(data, resolve, (error) =>
        reject(
          error ??
            new Error('The recording could not be decoded for this provider.'),
        ),
      );
    });
  } finally {
    void context.close();
  }
}

/** Averaging beats taking channel 0: it keeps signal if one channel is silent. */
function downmixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0);
  }

  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < mono.length; i += 1) {
      mono[i] += data[i]!;
    }
  }
  for (let i = 0; i < mono.length; i += 1) {
    mono[i]! /= buffer.numberOfChannels;
  }
  return mono;
}

/**
 * Linear interpolation is enough here: we only ever downsample speech that a
 * transcription model will resample again anyway, and the alternative
 * (`OfflineAudioContext`) costs an extra decode pass for no audible gain.
 */
function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) {
    return samples;
  }

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

/** 16-bit PCM in a canonical 44-byte-header RIFF/WAVE container. */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): ArrayBuffer {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    // Clamp before scaling so overdriven input wraps to full scale rather than
    // to the opposite polarity.
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
