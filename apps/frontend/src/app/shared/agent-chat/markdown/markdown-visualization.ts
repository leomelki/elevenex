import { Marked, type Token, type TokensList } from 'marked';

const PREFIX = 'visualize';
const literalLexer = new Marked({ breaks: true, gfm: true });

interface VisualizationToken {
  type: 'visualization';
  raw: string;
  path: string;
}

export type AgentMarkdownPart =
  | { kind: 'markdown'; key: string; content: string | TokensList }
  | { kind: 'visualization'; key: string; path: string };

/** Standalone directives only; marked keeps code examples and raw HTML inert. */
const lexer = new Marked({
  breaks: true,
  gfm: true,
  extensions: [
    {
      name: 'visualization',
      level: 'block',
      start(src) {
        const match = /(?:^|\n) {0,3}visualize/.exec(src);
        return match ? match.index + (src[match.index] === '\n' ? 1 : 0) : undefined;
      },
      tokenizer(src): VisualizationToken | undefined {
        const match = /^ {0,3}visualize([^\n]*?)[ \t]*(?:\n|$)/.exec(src);
        if (!match) return;
        try {
          const payload: unknown = JSON.parse(match[1]);
          if (!payload || typeof payload !== 'object' || !('path' in payload)) return;
          const path = payload.path;
          if (typeof path !== 'string' || !path.trim() || /[\u0000-\u001f\u007f]/.test(path))
            return;
          return { type: 'visualization', raw: match[0], path };
        } catch {
          // Partial streaming payloads and malformed directives remain visible text.
          return;
        }
      },
    },
  ],
});

export function splitMarkdownVisualizations(content: string): AgentMarkdownPart[] {
  if (!content.includes(PREFIX)) return [{ kind: 'markdown', key: 'markdown-0', content }];
  const tokens = lexer.lexer(content);
  const embeds = new Set(tokens.filter((token) => token.type === 'visualization'));
  if (!embeds.size) return [{ kind: 'markdown', key: 'markdown-0', content }];
  // Block extensions also run inside lists/quotes. These are literal examples,
  // so restore regular Markdown tokens before the ordinary parser sees them.
  lexer.walkTokens(tokens, (token) => {
    if (token.type === 'visualization' && !embeds.has(token)) {
      Object.assign(token, literalLexer.lexer(token.raw)[0]);
    }
  });
  const parts: AgentMarkdownPart[] = [];
  let section: Token[] = [];
  let index = 0;
  const flush = () => {
    if (!section.some((token) => token.type !== 'space' && token.type !== 'def')) {
      section = [];
      return;
    }
    // Preserve the document's reference definitions across embed boundaries.
    const content = Object.assign(section, { links: tokens.links }) as TokensList;
    parts.push({ kind: 'markdown', key: `markdown-${index}`, content });
    section = [];
  };
  for (const token of tokens) {
    if (token.type !== 'visualization') {
      section.push(token);
      continue;
    }
    flush();
    const path = (token as VisualizationToken).path;
    parts.push({ kind: 'visualization', key: `visualization-${index++}-${path}`, path });
  }
  flush();
  return parts;
}

/** Resolve local HTML without ever treating agent input as an iframe URL. */
export function resolveVisualizationTarget(
  path: string,
  worktreePath: string | null,
  sourcePath: string | null,
): { root: string; path: string } | null {
  let target = path.replace(/\\/g, '/');
  if (/^file:/i.test(target)) {
    try {
      const url = new URL(target);
      if (url.hostname && url.hostname !== 'localhost') return null;
      target = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(target)) target = target.slice(1);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:\//i.test(target)) {
    return null;
  }
  if (target.startsWith('//') || /[\u0000-\u001f\u007f]/.test(target)) return null;
  if (!/\.html?$/i.test(target)) return null;
  if (!/^(?:\/|[a-z]:\/|~\/)/i.test(target)) {
    if (!worktreePath) return null;
    const base = sourcePath?.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    target = `${worktreePath.replace(/\\/g, '/').replace(/\/$/, '')}/${base ? `${base}/` : ''}${target}`;
  }
  const slash = target.lastIndexOf('/');
  if (slash < 0) return null;
  // Scope the capability to the artifact's directory, including sibling assets.
  let root = target.slice(0, slash) || '/';
  if (/^[a-z]:$/i.test(root)) root += '/';
  return { root, path: target.slice(slash + 1) };
}

/** Authenticate link targets against the capability, never a frame's claims. */
export function resolveVisualizationNavigation(
  href: string,
  urlPrefix: string,
): { path: string; search: string; hash: string } | null {
  try {
    const prefix = new URL(urlPrefix, document.baseURI);
    const url = new URL(href, prefix);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.origin !== prefix.origin ||
      !url.pathname.startsWith(prefix.pathname)
    )
      return null;
    const decoded = decodeURIComponent(url.pathname.slice(prefix.pathname.length));
    const segments: string[] = [];
    // URL parsing does not collapse percent-encoded slashes. Check again after
    // decoding, before rebuilding a URL that would normalize '..' outside it.
    for (const segment of decoded.replace(/\\/g, '/').split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (!segments.length) return null;
        segments.pop();
      } else segments.push(segment);
    }
    const path = segments.join('/') + (decoded.endsWith('/') && segments.length ? '/' : '');
    if (/[\u0000-\u001f\u007f]/.test(path) || (path && !/\.html?$|\/$/i.test(path))) return null;
    return { path, search: url.search, hash: url.hash };
  } catch {
    return null;
  }
}
