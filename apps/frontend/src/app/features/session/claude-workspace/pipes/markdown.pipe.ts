import { Pipe, PipeTransform, SecurityContext, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';

const marked = new Marked({
  breaks: true,
  gfm: true,
  async: false,
  renderer: {
    code(this: unknown, { text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      try {
        const highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        return `<pre class="cw-code"><code class="hljs language-${language}">${highlighted}</code></pre>`;
      } catch {
        const escaped = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
        return `<pre class="cw-code"><code>${escaped}</code></pre>`;
      }
    },
  },
});

@Pipe({ name: 'cwMarkdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(value: string | null | undefined): SafeHtml {
    if (!value) return '';
    const rendered = marked.parse(value) as string;
    const clean = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
    return this.sanitizer.sanitize(SecurityContext.HTML, clean) ?? '';
  }
}
