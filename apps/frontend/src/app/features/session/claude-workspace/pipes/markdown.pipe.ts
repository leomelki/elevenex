import { Pipe, PipeTransform, SecurityContext, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Marked, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { getApiBaseUrl } from '@/shared/runtime/runtime-config';

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

function escapeHtmlAttr(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

// Matches an existing URL scheme (data:, http:, https:, etc). Paths without one are
// treated as local files and rewritten to the backend's worktree file API so they can
// be loaded regardless of whether the backend is local or reached through an SSH tunnel.
const HAS_URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function resolveImageSrc(href: string, worktreePath: string | null | undefined): string {
  if (!worktreePath || !href || HAS_URL_SCHEME.test(href) || href.startsWith('//')) {
    return href;
  }
  const relativePath = href.replace(/^\.\//, '');
  const encodedWorktree = encodeURIComponent(worktreePath);
  const encodedPath = encodeURIComponent(relativePath);
  return `${getApiBaseUrl()}/worktrees/${encodedWorktree}/raw/${encodedPath}`;
}

function createMarked(worktreePath?: string | null): Marked {
  return new Marked({
    breaks: true,
    gfm: true,
    async: false,
    renderer: {
      code: codeRenderer,
      image({ href, title, text }: Tokens.Image) {
        const src = resolveImageSrc(href, worktreePath);
        const titleAttr = title ? ` title="${escapeHtmlAttr(title)}"` : '';
        return `<img src="${escapeHtmlAttr(src)}" alt="${escapeHtmlAttr(text)}"${titleAttr}>`;
      },
    },
  });
}

const defaultMarked = createMarked(null);

@Pipe({ name: 'cwMarkdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(value: string | null | undefined, worktreePath?: string | null): SafeHtml {
    if (!value) return '';
    const renderer = worktreePath ? createMarked(worktreePath) : defaultMarked;
    const rendered = renderer.parse(value) as string;
    const clean = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
    return this.sanitizer.sanitize(SecurityContext.HTML, clean) ?? '';
  }
}
