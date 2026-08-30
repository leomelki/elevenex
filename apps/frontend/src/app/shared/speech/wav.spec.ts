import { describe, expect, it } from 'vitest';
import { TARGET_SAMPLE_RATE, encodeWav } from './wav';

function ascii(view: DataView, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(view.getUint8(offset + i));
  }
  return text;
}

describe('encodeWav', () => {
  it('writes a canonical 44-byte RIFF/WAVE header for 16-bit mono PCM', () => {
    const samples = new Float32Array(8);
    const view = new DataView(encodeWav(samples, TARGET_SAMPLE_RATE));

    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(ascii(view, 36, 4)).toBe('data');

    expect(view.getUint32(16, true)).toBe(16); // PCM fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // format: PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(TARGET_SAMPLE_RATE);
    expect(view.getUint32(28, true)).toBe(TARGET_SAMPLE_RATE * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it('sizes the buffer and its two length fields consistently', () => {
    const samples = new Float32Array(100);
    const buffer = encodeWav(samples, TARGET_SAMPLE_RATE);
    const view = new DataView(buffer);

    expect(buffer.byteLength).toBe(44 + 200);
    expect(view.getUint32(4, true)).toBe(36 + 200); // RIFF chunk size
    expect(view.getUint32(40, true)).toBe(200); // data chunk size
  });

  it('scales samples to full 16-bit range without wrapping polarity', () => {
    const samples = new Float32Array([0, 1, -1, 0.5, -0.5]);
    const view = new DataView(encodeWav(samples, TARGET_SAMPLE_RATE));

    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
    expect(view.getInt16(50, true)).toBe(16383);
    expect(view.getInt16(52, true)).toBe(-16384);
  });

  it('clamps out-of-range input instead of wrapping it', () => {
    // Overdriven input must saturate; wrapping would turn a loud positive peak
    // into a loud negative one and produce audible clicks.
    const samples = new Float32Array([2, -2, 1.0001]);
    const view = new DataView(encodeWav(samples, TARGET_SAMPLE_RATE));

    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(32767);
  });

  it('handles an empty recording without producing a malformed header', () => {
    const buffer = encodeWav(new Float32Array(0), TARGET_SAMPLE_RATE);
    expect(buffer.byteLength).toBe(44);
    expect(new DataView(buffer).getUint32(40, true)).toBe(0);
  });
});
