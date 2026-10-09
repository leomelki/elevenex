import { getApiBaseUrl } from '@/shared/runtime/runtime-config';

/** Refresh host files without altering remote signed URLs or embedded attachments. */
export function freshLocalMediaUrl(src: string, revision: string): string {
  try {
    const url = new URL(src, document.baseURI);
    const api = new URL(getApiBaseUrl(), document.baseURI);
    const prefix = api.pathname.replace(/\/$/, '');
    const localMedia =
      url.origin === api.origin &&
      (url.pathname === `${prefix}/filesystem/media` ||
        (url.pathname.startsWith(`${prefix}/worktrees/`) && url.pathname.includes('/raw/')));
    if (!localMedia) return src;
    url.searchParams.set('_media', revision);
    return url.href;
  } catch {
    return src;
  }
}
