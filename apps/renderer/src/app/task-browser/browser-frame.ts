/** Validate allocation bounds from the encoded JPEG header before invoking an image decoder. */
export function browserFrameSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (
    bytes.length < 10 ||
    bytes.length > 3000000 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216
  )
    return null;
  let offset = 2;
  for (
    let segment = 0;
    segment < 128 && offset + 4 <= bytes.length && offset < 65536;
    segment++
  ) {
    if (bytes[offset++] !== 255) return null;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 217 || marker === 218) return null;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    const size = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (size < 2 || offset + size > bytes.length) return null;
    if (
      [
        192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
      ].includes(marker)
    ) {
      if (size < 8) return null;
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      return width > 0 &&
        height > 0 &&
        width <= 4096 &&
        height <= 4096 &&
        width * height <= 8000000
        ? { width, height }
        : null;
    }
    offset += size;
  }
  return null;
}
