import { SecurityContext } from '@angular/core';
import type { DomSanitizer, SafeHtml } from '@angular/platform-browser';

const VIDEO_FILE = /\.(?:mp4|webm|ogv|mov|m4v)$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function safeMediaUrl(value: string): string | null {
  const url = value.trim();
  if (!url || /[\u0000-\u001f\u007f]/.test(url)) return null;
  if (URL_SCHEME.test(url) && !/^(?:https?|blob):/i.test(url)) return null;
  return url;
}

/**
 * Angular strips video/source tags. Keep its sanitizer for the surrounding HTML,
 * then restore players built from an explicit attribute allowlist. Input HTML
 * has already passed through DOMPurify; no agent-provided HTML is trusted here.
 */
export function sanitizeWithVideos(
  html: string,
  sanitizer: DomSanitizer,
  resolveSrc: (src: string) => string,
): SafeHtml {
  const template = document.createElement('template');
  template.innerHTML = html;
  const players = new Map<string, HTMLVideoElement>();
  for (const element of Array.from(template.content.querySelectorAll('video, img[src], a[href]'))) {
    // Links/images inside an HTML player are its fallback content, not new embeds.
    if (element.parentElement?.closest('video')) continue;
    const src = element.getAttribute(element.tagName === 'A' ? 'href' : 'src');
    if (element.tagName !== 'VIDEO' && (!src || !VIDEO_FILE.test(src.split(/[?#]/)[0]))) continue;

    const video = document.createElement('video');
    video.setAttribute('controls', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('preload', 'metadata');
    video.className = 'cw-video';
    const setUrl = (target: Element, attribute: string, value: string | null) => {
      const safeUrl = value && safeMediaUrl(value);
      if (safeUrl) target.setAttribute(attribute, resolveSrc(safeUrl));
    };
    setUrl(video, 'src', src);
    setUrl(video, 'poster', element.getAttribute('poster'));
    const label =
      element.getAttribute('aria-label') ||
      element.getAttribute('alt') ||
      element.getAttribute('title') ||
      (element.tagName === 'A' ? element.textContent : null);
    if (label) video.setAttribute('aria-label', label);
    for (const attribute of ['width', 'height']) {
      const value = element.getAttribute(attribute);
      if (value && /^\d+$/.test(value)) video.setAttribute(attribute, value);
    }
    for (const source of Array.from(element.querySelectorAll('source[src]'))) {
      const child = document.createElement('source');
      setUrl(child, 'src', source.getAttribute('src'));
      if (!child.hasAttribute('src')) continue;
      const type = source.getAttribute('type');
      if (type) child.setAttribute('type', type);
      video.append(child);
    }
    video.append(document.createTextNode('Your browser does not support embedded video.'));
    const placeholder = document.createElement('span');
    placeholder.className = 'cw-video-placeholder';
    placeholder.textContent = crypto.randomUUID();
    players.set(placeholder.textContent, video);
    element.replaceWith(placeholder);
  }

  const clean = sanitizer.sanitize(SecurityContext.HTML, template.innerHTML) ?? '';
  if (!players.size) return clean;
  template.innerHTML = clean;
  for (const placeholder of Array.from(
    template.content.querySelectorAll('span.cw-video-placeholder'),
  )) {
    const player = players.get(placeholder.textContent ?? '');
    if (player) placeholder.replaceWith(player);
  }
  // Only the allowlisted players bypass Angular's sanitizer. Everything else
  // in this result has passed through both DOMPurify and Angular.
  return sanitizer.bypassSecurityTrustHtml(template.innerHTML);
}
