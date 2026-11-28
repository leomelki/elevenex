/** Xvfb, the encoder and input injection use one immutable pixel geometry per run. */
export interface AppDisplaySize {
  readonly width: number;
  readonly height: number;
}

const desktop: AppDisplaySize = Object.freeze({ width: 1280, height: 800 });
const phone: AppDisplaySize = Object.freeze({ width: 720, height: 1280 });

export function appDisplaySize(request: { readonly virtualDisplay?: AppDisplaySize; readonly android?: unknown }): AppDisplaySize {
  const size = request.virtualDisplay ?? (request.android ? phone : desktop);
  const validAxis = (axis: number) => Number.isSafeInteger(axis) && axis >= 240 && axis <= 1920 && axis % 2 === 0;
  if (!validAxis(size.width) || !validAxis(size.height) || size.width * size.height > 1920 * 1080)
    throw new Error('Use even display dimensions between 240 and 1920 pixels, up to 1920 × 1080 total pixels.');
  return size;
}
