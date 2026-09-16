import { Pipe, PipeTransform, SecurityContext, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Marked, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { getApiBaseUrl } from '@/shared/runtime/runtime-config';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';

function codeRenderer(this: unknown, { text, lang }: { text: string; lang?: string }) {
  const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
  try {
    const highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    return `<pre class="cw-code"><code class="hljs language-${language}">${highlighted}</code></pre>`;
  } catch {
    const escaped = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    return `<pre class="cw-code"><code>${escaped}</code></pre>`;
  }
}

// Matches an existing URL scheme (data:, http:, https:, etc). Paths without one are
// treated as local files and rewritten to the backend's worktree file API so they can
// be loaded regardless of whether the backend is local or reached through an SSH tunnel.
const HAS_URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;

/**
 * Collapse `.` and `..` segments into a clean worktree-relative path.
 *
 * A `..` that would climb above the worktree root is dropped rather than kept:
 * the backend rejects traversal anyway, so keeping it only turns a recoverable
 * path into a guaranteed 404.
 */
function normalizeSegments(segments: readonly string[]): string {
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join('/');
}

/** Directory a document's relative links resolve against, as path segments. */
function baseDirSegments(sourcePath: string | null | undefined): readonly string[] {
  if (!sourcePath) return [];
  return sourcePath.replace(/\\/g, '/').split('/').slice(0, -1);
}

/** Image targets are URLs, so `my%20shot.png` names the file `my shot.png`. */
function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A lone `%` that is not an escape is part of the filename.
    return value;
  }
}

/**
 * Point an image at the backend's raw-file endpoint.
 *
 * Relative hrefs resolve against `baseDir` — the directory of the document
 * being rendered — because that is what they mean in the file on disk. A doc
 * at `docs/guide.md` writing `./img/a.png` means `docs/img/a.png`, not
 * `img/a.png`. An absolute path inside the worktree, which is how agents cite
 * files, is that worktree file; any other leading `/` is worktree-root-relative.
 */
function resolveImageSrc(src: string, worktreePath: string, baseDir: readonly string[]): string {
  if (!src || HAS_URL_SCHEME.test(src) || src.startsWith('//')) return src;

  // A query or fragment is meaningless for a file read, and encoding it into
  // the path would look for a filename that contains the `?`.
  const filePath = decodePath(src.split(/[?#]/)[0]);
  if (!filePath) return src;

  const root = worktreePath.replace(/[\\/]+$/, '');
  const segments = filePath.startsWith(`${root}/`)
    ? filePath.slice(root.length + 1).split('/')
    : filePath.startsWith('/')
      ? filePath.split('/')
      : [...baseDir, ...filePath.split('/')];
  const relativePath = normalizeSegments(segments);
  if (!relativePath) return src;

  const encodedWorktree = encodeURIComponent(worktreePath);
  const encodedPath = encodeURIComponent(relativePath);
  return `${getApiBaseUrl()}/worktrees/${encodedWorktree}/raw/${encodedPath}`;
}

/**
 * Resolve every local `<img>` in sanitized HTML.
 *
 * Done on the parsed output rather than in marked's image renderer so it also
 * reaches raw HTML: documents size images with `<img src width>`, which marked
 * passes through untouched and the browser would otherwise resolve against the
 * app's own URL. A `<template>` keeps the pass inert — images parsed into it do
 * not start fetching the unresolved `src`.
 */
function resolveLocalImages(
  html: string,
  worktreePath: string,
  baseDir: readonly string[],
): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const image of Array.from(template.content.querySelectorAll('img[src]'))) {
    image.setAttribute(
      'src',
      resolveImageSrc(image.getAttribute('src') ?? '', worktreePath, baseDir),
    );
  }
  return template.innerHTML;
}

function normalizeLocalFilePath(segments: readonly string[]): string | null {
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!resolved.length) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join('/') || null;
}

/** Resolve a Markdown href to a location inside the current worktree. */
export function resolveLocalFileTarget(
  href: string,
  worktreePath: string,
  sourcePath?: string | null,
): LocalFileTarget | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null;

  let rawTarget = href;
  if (rawTarget.startsWith('file://')) {
    try {
      rawTarget = new URL(rawTarget).pathname;
    } catch {
      return null;
    }
  } else if (HAS_URL_SCHEME.test(rawTarget) && !WINDOWS_ABSOLUTE_PATH.test(rawTarget)) {
    return null;
  }

  const hashIndex = rawTarget.indexOf('#');
  const fragment = hashIndex >= 0 ? rawTarget.slice(hashIndex + 1) : '';
  rawTarget = hashIndex >= 0 ? rawTarget.slice(0, hashIndex) : rawTarget;
  rawTarget = rawTarget.split('?')[0];

  let line: number | undefined;
  let column: number | undefined;
  const fragmentLocation = /^L(\d+)(?:C(\d+))?(?:-L\d+(?:C\d+)?)?$/i.exec(fragment);
  if (fragmentLocation) {
    line = Number(fragmentLocation[1]);
    column = fragmentLocation[2] ? Number(fragmentLocation[2]) : undefined;
  } else {
    const suffixLocation = /:(\d+)(?::(\d+))?$/.exec(rawTarget);
    if (suffixLocation) {
      line = Number(suffixLocation[1]);
      column = suffixLocation[2] ? Number(suffixLocation[2]) : undefined;
      rawTarget = rawTarget.slice(0, suffixLocation.index);
    }
  }

  let decodedPath = decodePath(rawTarget).replace(/\\/g, '/');
  const root = worktreePath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (WINDOWS_ABSOLUTE_PATH.test(root) && /^\/[a-z]:\//i.test(decodedPath)) {
    decodedPath = decodedPath.slice(1);
  }
  const pathIsInsideRoot = WINDOWS_ABSOLUTE_PATH.test(root)
    ? decodedPath.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : decodedPath.startsWith(`${root}/`);
  let segments: string[];
  if (pathIsInsideRoot) {
    segments = decodedPath.slice(root.length + 1).split('/');
  } else if (WINDOWS_ABSOLUTE_PATH.test(decodedPath)) {
    return null;
  } else if (decodedPath.startsWith('/')) {
    // Root-relative links make sense in repository documents. Agent links with
    // unrelated absolute paths must not be allowed to escape the worktree.
    if (!sourcePath) return null;
    segments = decodedPath.slice(1).split('/');
  } else {
    segments = [...baseDirSegments(sourcePath), ...decodedPath.split('/')];
  }

  const path = normalizeLocalFilePath(segments);
  if (!path) return null;
  return { path, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

function annotateLocalFileLinks(
  html: string,
  worktreePath: string,
  sourcePath?: string | null,
): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const anchor of Array.from(
    template.content.querySelectorAll<HTMLAnchorElement>('a[href]'),
  )) {
    const target = resolveLocalFileTarget(
      anchor.getAttribute('href') ?? '',
      worktreePath,
      sourcePath,
    );
    if (!target) continue;
    anchor.classList.add('cw-local-file-link');
  }
  return template.innerHTML;
}

const marked = new Marked({
  breaks: true,
  gfm: true,
  async: false,
  renderer: {
    code: codeRenderer,
    // Angular's HTML sanitizer drops `<input>` outright, so marked's default
    // task-list checkbox never survives to the DOM and a checklist reads as a
    // plain list with a stray leading space. A glyph in a span survives, and
    // carries its state to a screen reader as text rather than as an
    // attribute the sanitizer would also strip.
    checkbox({ checked }: Tokens.Checkbox) {
      const modifier = checked ? 'cw-task--done' : 'cw-task--todo';
      return `<span class="cw-task ${modifier}">${checked ? '☑' : '☐'}</span>`;
    },
  },
});

@Pipe({ name: 'cwMarkdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  /**
   * @param worktreePath Absolute worktree the document lives in; enables local images.
   * @param sourcePath Worktree-relative path of the document, so its relative
   *   image links resolve against its own directory.
   */
  transform(
    value: string | null | undefined,
    worktreePath?: string | null,
    sourcePath?: string | null,
  ): SafeHtml {
    if (!value) return '';
    const rendered = marked.parse(value) as string;
    let clean = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
    if (worktreePath) {
      if (clean.includes('<img')) {
        clean = resolveLocalImages(clean, worktreePath, baseDirSegments(sourcePath));
      }
      if (clean.includes('<a')) {
        clean = annotateLocalFileLinks(clean, worktreePath, sourcePath);
      }
    }
    return this.sanitizer.sanitize(SecurityContext.HTML, clean) ?? '';
  }
}
