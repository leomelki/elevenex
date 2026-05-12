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
    return `<span class="cw-diff-${type}">${prefix}${content || ' '}</span>`;
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

type LineDiff =
  | { type: 'context'; oldLine: number; newLine: number; oldIndex: number; newIndex: number }
  | { type: 'del'; oldLine: number; oldIndex: number }
  | { type: 'add'; newLine: number; newIndex: number };

function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.slice(0, -1) : lines;
}

function buildLineDiff(oldLines: string[], newLines: string[]): LineDiff[] {
  const cells = oldLines.length * newLines.length;
  if (cells > 200_000) {
    return [
      ...oldLines.map((_, index) => ({ type: 'del' as const, oldLine: index + 1, oldIndex: index })),
      ...newLines.map((_, index) => ({ type: 'add' as const, newLine: index + 1, newIndex: index })),
    ];
  }

  const dp = Array.from({ length: oldLines.length + 1 }, () =>
    Array<number>(newLines.length + 1).fill(0),
  );
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: LineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      out.push({ type: 'context', oldLine: i + 1, newLine: j + 1, oldIndex: i, newIndex: j });
      i++;
      j++;
      continue;
    }
    if (j < newLines.length && (i === oldLines.length || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push({ type: 'add', newLine: j + 1, newIndex: j });
      j++;
      continue;
    }
    if (i < oldLines.length) {
      out.push({ type: 'del', oldLine: i + 1, oldIndex: i });
      i++;
    }
  }
  return out;
}

function renderUnifiedDiffLine(
  type: 'add' | 'del' | 'context',
  oldLine: number | null,
  newLine: number | null,
  content: string,
): string {
  const marker = type === 'add' ? '+' : type === 'del' ? '-' : ' ';
  const oldText = oldLine === null ? '' : String(oldLine);
  const newText = newLine === null ? '' : String(newLine);
  return [
    `<span class="cw-diff-line cw-diff-${type}">`,
    `<span class="cw-diff-ln cw-diff-ln--old">${oldText}</span>`,
    `<span class="cw-diff-ln cw-diff-ln--new">${newText}</span>`,
    `<span class="cw-diff-marker">${marker}</span>`,
    `<span class="cw-diff-code">${content || ' '}</span>`,
    '</span>',
  ].join('');
}

export function highlightedUnifiedDiffHtml(
  oldStr: string,
  newStr: string,
  filePath: string,
): string {
  const lang = detectHljsLang(filePath);
  const oldLines = splitDiffLines(oldStr);
  const newLines = splitDiffLines(newStr);
  const oldHl = highlightLines(oldLines.join('\n'), lang);
  const newHl = highlightLines(newLines.join('\n'), lang);
  const diff = buildLineDiff(oldLines, newLines);

  return diff.map((line) => {
    if (line.type === 'context') {
      return renderUnifiedDiffLine('context', line.oldLine, line.newLine, newHl[line.newIndex] ?? '');
    }
    if (line.type === 'add') {
      return renderUnifiedDiffLine('add', null, line.newLine, newHl[line.newIndex] ?? '');
    }
    return renderUnifiedDiffLine('del', line.oldLine, null, oldHl[line.oldIndex] ?? '');
  }).join('');
}

export function highlightedPatchHtml(patch: string, filePath = ''): string {
  const lang = detectHljsLang(filePath);
  const lines = splitDiffLines(patch);

  // Build a parallel array of stripped code content for batch syntax highlighting.
  // @@ hunk headers and "no newline" notices get empty slots so indices stay aligned.
  const codeLines = lines.map((line) => {
    if (line.startsWith('@@') || line.startsWith('\\')) return '';
    if (line.startsWith('+') || line.startsWith('-')) return line.slice(1);
    return line.startsWith(' ') ? line.slice(1) : line;
  });
  const highlighted = highlightLines(codeLines.join('\n'), lang);

  let oldLine = 1;
  let newLine = 1;
  let hasHunkHeader = false;

  return lines.map((line, i) => {
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
        hasHunkHeader = true;
      }
      return `<span class="cw-diff-line cw-diff-hunk"><span class="cw-diff-ln cw-diff-ln--old"></span><span class="cw-diff-ln cw-diff-ln--new"></span><span class="cw-diff-marker"> </span><span class="cw-diff-code">${escapeHtml(line)}</span></span>`;
    }
    if (line.startsWith('\\')) return '';
    const hl = highlighted[i] ?? '';
    if (line.startsWith('+')) {
      return renderUnifiedDiffLine('add', null, newLine++, hl);
    }
    if (line.startsWith('-')) {
      return renderUnifiedDiffLine('del', oldLine++, null, hl);
    }
    // context line — only show line numbers once a hunk header has set them
    return renderUnifiedDiffLine('context', hasHunkHeader ? oldLine++ : null, hasHunkHeader ? newLine++ : null, hl);
  }).filter(Boolean).join('');
}
