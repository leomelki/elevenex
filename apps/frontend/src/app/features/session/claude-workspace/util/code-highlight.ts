import hljs from 'highlight.js/lib/common';

const EXTENSION_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  md: 'markdown', markdown: 'markdown',
  sql: 'sql', dockerfile: 'dockerfile',
  vue: 'xml', svelte: 'xml',
};

export function detectHljsLang(filePath: string): string | null {
  if (!filePath) return null;
  const base = filePath.split(/[\\/]/).pop() ?? '';
  if (/^Dockerfile(\..+)?$/i.test(base)) return 'dockerfile';
  if (/^Makefile$/i.test(base)) return 'makefile';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  const lang = EXTENSION_TO_LANG[ext];
  if (lang && hljs.getLanguage(lang)) return lang;
  return hljs.getLanguage(ext) ? ext : null;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

// hljs may emit spans that span multiple lines (multi-line strings, template
// literals, block comments). A naive split on '\n' would leave orphan opening
// or closing tags on each line. Walk the HTML, track open <span> tags, and
// close/reopen them across line boundaries so each rendered line is valid HTML.
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) {
        current += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith('</')) {
        open.pop();
      } else if (!tag.endsWith('/>')) {
        open.push(tag);
      }
      current += tag;
      i = end + 1;
    } else if (ch === '\n') {
      const closers = '</span>'.repeat(open.length);
      lines.push(current + closers);
      current = open.join('');
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  lines.push(current);
  return lines;
}

export function highlightLines(text: string, lang: string | null): string[] {
  if (!text) return [''];
  let html: string;
  try {
    html = lang
      ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(text).value;
  } catch {
    html = escapeHtml(text);
  }
  return splitHighlightedLines(html);
}

// Build the HTML for an Edit-tool diff with per-line syntax highlighting.
// Compares old/new line-by-line for the diff signal but feeds the full
// strings to hljs so multi-line constructs (template literals, block
// comments) are highlighted in context. Each rendered line is wrapped in a
// `cw-diff-{add|del|context}` span so callers keep their existing background
// CSS while the inner `.hljs` span carries the syntax-color tokens.
export function highlightedDiffHtml(
  oldStr: string,
  newStr: string,
  filePath: string,
): string {
  const lang = detectHljsLang(filePath);
  const oldHl = highlightLines(oldStr, lang);
  const newHl = highlightLines(newStr, lang);
  const oldRaw = oldStr.split('\n');
  const newRaw = newStr.split('\n');
  const max = Math.max(oldRaw.length, newRaw.length);

  const renderLine = (type: 'add' | 'del' | 'context', content: string): string => {
    const prefix = type === 'add' ? '+ ' : type === 'del' ? '- ' : '  ';
    return `<span class="cw-diff-${type} hljs">${prefix}${content || ' '}\n</span>`;
  };

  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const o = oldRaw[i];
    const n = newRaw[i];
    if (o === n && o !== undefined) {
      out.push(renderLine('context', newHl[i] ?? ''));
    } else {
      if (o !== undefined) out.push(renderLine('del', oldHl[i] ?? ''));
      if (n !== undefined) out.push(renderLine('add', newHl[i] ?? ''));
    }
  }
  return out.join('');
}
