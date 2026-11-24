export const WORKSPACE_PROJECT_IMAGE_SIZE = 80;
export const WORKSPACE_PROJECT_IMAGE_LIMIT = 36 * 1024;

// PNG signature and IHDR through the width and height (80 × 80).
const HEADER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAABQ';

export function isWorkspaceProjectImage(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= WORKSPACE_PROJECT_IMAGE_LIMIT &&
    value.startsWith(HEADER) &&
    (value.length - 'data:image/png;base64,'.length) % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(HEADER.length));
}
