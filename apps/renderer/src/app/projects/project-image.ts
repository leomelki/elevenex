import { isWorkspaceProjectImage, WORKSPACE_PROJECT_IMAGE_SIZE } from '@elevenex/shared';

export const PROJECT_IMAGE_ACCEPT = 'image/svg+xml,image/png,image/jpeg,image/webp,.svg,.png,.jpg,.jpeg,.webp';
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_SVG_SIZE = 512 * 1024;
const MAX_PIXELS = 32_000_000;

/** Normalize the selected logo locally, preserving transparency and aspect ratio. */
export async function readProjectImage(file: File, signal: AbortSignal): Promise<string> {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    return readSvgLogo(file, signal);
  }
  if (file.size > MAX_FILE_SIZE) throw new Error('Choose an image under 10 MB.');

  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const webp = String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('Choose an SVG, PNG, JPEG, or WebP image.');

  signal.throwIfAborted();
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This image could not be opened. Try another file.');
  });
  try {
    signal.throwIfAborted();
    return projectThumbnail(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function readSvgLogo(file: File, signal: AbortSignal): Promise<string> {
  if (file.size > MAX_SVG_SIZE) throw new Error('Choose an SVG under 512 KB.');
  const svg = await file.text();
  signal.throwIfAborted();

  // SVG image mode suppresses scripts, interaction and external resources.
  // Keep the image detached and send only the resulting PNG to the workspace.
  const image = new Image();
  const cancel = () => image.removeAttribute('src');
  signal.addEventListener('abort', cancel, { once: true });
  try {
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    signal.throwIfAborted();
    return projectThumbnail(image, image.naturalWidth, image.naturalHeight);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof DOMException) {
      throw new Error('This SVG could not be opened. Try exporting it again.', { cause: error });
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

function projectThumbnail(source: CanvasImageSource, width: number, height: number): string {
  if (!width || !height) throw new Error('This image has no visible size.');
  if (width * height > MAX_PIXELS) throw new Error('Choose an image under 32 megapixels.');

  const size = WORKSPACE_PROJECT_IMAGE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This image could not be prepared. Try again.');
  context.imageSmoothingQuality = 'high';
  const scale = size / Math.max(width, height);
  const fittedWidth = width * scale;
  const fittedHeight = height * scale;
  context.drawImage(source, (size - fittedWidth) / 2, (size - fittedHeight) / 2, fittedWidth, fittedHeight);

  const image = canvas.toDataURL('image/png');
  if (!isWorkspaceProjectImage(image)) throw new Error('This image could not be prepared. Try another file.');
  return image;
}
