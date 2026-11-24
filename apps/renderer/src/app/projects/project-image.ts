import { isWorkspaceProjectImage, WORKSPACE_PROJECT_IMAGE_SIZE } from '@elevenex/shared';

export const PROJECT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_PIXELS = 32_000_000;

/** Normalize the selected raster locally, preserving transparency and aspect ratio. */
export async function readProjectImage(file: File, signal: AbortSignal): Promise<string> {
  if (file.size > MAX_FILE_SIZE) throw new Error('Choose an image under 10 MB.');

  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const webp = String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('Choose a PNG, JPEG, or WebP image.');

  signal.throwIfAborted();
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This image could not be opened. Try another file.');
  });
  try {
    signal.throwIfAborted();
    if (bitmap.width * bitmap.height > MAX_PIXELS)
      throw new Error('This image is too large. Choose one under 32 megapixels.');

    const size = WORKSPACE_PROJECT_IMAGE_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This image could not be prepared. Try again.');
    context.imageSmoothingQuality = 'high';
    const scale = size / Math.max(bitmap.width, bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);

    const image = canvas.toDataURL('image/png');
    if (!isWorkspaceProjectImage(image)) throw new Error('This image could not be prepared. Try another file.');
    return image;
  } finally {
    bitmap.close();
  }
}
