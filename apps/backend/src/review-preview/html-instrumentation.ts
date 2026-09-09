import * as parse5 from 'parse5';

/**
 * Annotating worktree HTML so a selection in the rendered page can be mapped
 * back to the lines that produced it.
 *
 * parse5 gives every element its source location, so we can stamp each one
 * with the lines it spans and let the bridge walk up from the selection to the
 * nearest annotated ancestor. That is far more honest than the text matching
 * the markdown preview has to do, because here the renderer is the browser and
 * we control what it is handed.
 *
 * Pure and Nest-free on purpose: this is the part worth testing, and it should
 * not need an application to exercise.
 */

/** Above this size, skip annotation and just inject the bridge. */
const MAX_INSTRUMENTED_BYTES = 2_000_000;

/**
 * Attributes whose value can be a URL we may need to re-root.
 * `srcset` is handled separately because it holds a comma-separated list.
 */
const URL_ATTRIBUTES = new Set([
  'src',
  'href',
  'poster',
  'data',
  'action',
  'formaction',
]);

/** Elements whose children parse5 exposes on `.content` rather than inline. */
const TEMPLATE_TAG = 'template';

export interface InstrumentPreviewHtmlOptions {
  /** The file's own bytes, as UTF-8 text. */
  source: string;
  /** Absolute URL prefix the preview is served under; ends with a slash. */
  previewPrefix: string;
  /** Worktree-relative path of this document, echoed back by the bridge. */
  filePath: string;
  previewId: string;
  /** URL of the bridge script to inject. */
  bridgeUrl: string;
}

export interface InstrumentPreviewHtmlResult {
  html: string;
  /**
   * False when annotation was skipped or failed. The page still works and the
   * bridge is still injected — selections just fall back to DOM anchors.
   */
  instrumented: boolean;
}

export function transformPreviewHtml(
  options: InstrumentPreviewHtmlOptions,
): InstrumentPreviewHtmlResult {
  const { source } = options;

  if (source.length > MAX_INSTRUMENTED_BYTES) {
    return { html: injectBridgeByConcat(source, options), instrumented: false };
  }

  try {
    const document = parse5.parse(source, { sourceCodeLocationInfo: true });
    annotate(document, options.previewPrefix);
    injectBridgeNode(document, options);
    const html = parse5.serialize(document);

    // A serializer that lost most of the document is worse than no
    // instrumentation at all, so treat a large shrink as a failed parse.
    if (html.length < source.length * 0.5) {
      return { html: injectBridgeByConcat(source, options), instrumented: false };
    }

    return { html, instrumented: true };
  } catch {
    return { html: injectBridgeByConcat(source, options), instrumented: false };
  }
}

/** Minimal shape we need; avoids depending on parse5's adapter generics. */
interface ElementLike {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: ElementLike[];
  content?: ElementLike;
  sourceCodeLocation?: {
    startLine: number;
    endLine: number;
    startTag?: { endOffset: number };
    endTag?: { startOffset: number };
  } | null;
}

function annotate(document: unknown, previewPrefix: string): void {
  let nextId = 1;

  const visit = (node: ElementLike): void => {
    // Elements only. Text, comments and doctype have no tagName.
    if (typeof node.tagName === 'string') {
      const location = node.sourceCodeLocation;
      // A null location means the parser invented this node — an implied
      // <tbody>, or <html>/<body> in a fragment. It has no source to point at,
      // so leaving it unannotated is the honest answer rather than a guess.
      if (location) {
        const attrs = (node.attrs ??= []);
        setAttr(attrs, 'data-ex-line', String(location.startLine));
        setAttr(attrs, 'data-ex-end-line', String(location.endLine));
        setAttr(attrs, 'data-ex-id', String(nextId++));

        // Only meaningful for elements with both tags: it is the span of the
        // inner content, used for the narrow intra-element refinement.
        if (location.startTag && location.endTag) {
          setAttr(attrs, 'data-ex-so', String(location.startTag.endOffset));
          setAttr(attrs, 'data-ex-eo', String(location.endTag.startOffset));
        }
      }

      if (node.attrs) rewriteRootAbsoluteUrls(node.attrs, previewPrefix);
    }

    // Template contents never render, so there is nothing to select in them.
    if (node.tagName === TEMPLATE_TAG) return;

    for (const child of node.childNodes ?? []) visit(child);
  };

  visit(document as ElementLike);
}

function setAttr(
  attrs: { name: string; value: string }[],
  name: string,
  value: string,
): void {
  const existing = attrs.find((attr) => attr.name === name);
  if (existing) {
    existing.value = value;
    return;
  }
  attrs.push({ name, value });
}

/**
 * Re-root URLs that start at the server root.
 *
 * Relative URLs already resolve correctly, because the preview mirrors the
 * worktree's directory layout. Root-absolute ones do not, and they are what
 * bundlers emit — a Vite or CRA build references `/assets/index-abc.js`. This
 * is the cheapest thing that makes built output work.
 *
 * Not handled, deliberately: `url(/…)` inside a stylesheet or a `style`
 * attribute. Rewriting those means parsing CSS, which is not worth it;
 * relative `url(./x.png)` in a linked stylesheet already resolves fine.
 */
function rewriteRootAbsoluteUrls(
  attrs: { name: string; value: string }[],
  previewPrefix: string,
): void {
  for (const attr of attrs) {
    if (attr.name === 'srcset') {
      attr.value = rewriteSrcset(attr.value, previewPrefix);
      continue;
    }
    if (!URL_ATTRIBUTES.has(attr.name)) continue;
    attr.value = rewriteUrl(attr.value, previewPrefix);
  }
}

function rewriteUrl(value: string, previewPrefix: string): string {
  // `//host/path` is protocol-relative, not root-absolute — leave it alone.
  if (!value.startsWith('/') || value.startsWith('//')) return value;
  return previewPrefix + value.slice(1);
}

function rewriteSrcset(value: string, previewPrefix: string): string {
  return value
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return candidate;
      const [url, ...descriptors] = trimmed.split(/\s+/);
      return [rewriteUrl(url, previewPrefix), ...descriptors].join(' ');
    })
    .join(', ');
}

/**
 * The bridge tag.
 *
 * External rather than inline on purpose. An inline script would need either
 * `'unsafe-inline'` — which we already grant the page — or a nonce, and adding
 * a nonce to `script-src` makes browsers *ignore* `'unsafe-inline'`, breaking
 * every repo page that has an inline script. An external script under the
 * preview prefix sidesteps the conflict entirely.
 */
function bridgeTag(options: InstrumentPreviewHtmlOptions, instrumented: boolean): string {
  return (
    `<script src="${escapeAttr(options.bridgeUrl)}"` +
    ` data-ex-preview-id="${escapeAttr(options.previewId)}"` +
    ` data-ex-path="${escapeAttr(options.filePath)}"` +
    ` data-ex-prefix="${escapeAttr(options.previewPrefix)}"` +
    ` data-ex-instrumented="${instrumented ? '1' : '0'}"></script>`
  );
}

/**
 * Insert the bridge as the first child of <head>.
 *
 * First matters: the bridge installs a storage shim that a lot of pages need
 * before their own first line runs.
 */
function injectBridgeNode(
  document: unknown,
  options: InstrumentPreviewHtmlOptions,
): void {
  const head = findElement(document as ElementLike, 'head');
  const fragment = parse5.parseFragment(bridgeTag(options, true)) as ElementLike;
  const scriptNode = fragment.childNodes?.[0];
  if (!scriptNode) return;

  // parse5 always synthesises <head> for a full document parse, so this is
  // only defensive.
  const parent = head ?? (findElement(document as ElementLike, 'html') as ElementLike);
  if (!parent) return;
  parent.childNodes = [scriptNode, ...(parent.childNodes ?? [])];
}

function findElement(root: ElementLike, tagName: string): ElementLike | null {
  if (root.tagName === tagName) return root;
  for (const child of root.childNodes ?? []) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return null;
}

/**
 * The fallback path: no parsing, just get the bridge in front of the page.
 *
 * Used when the document is too large to annotate or when parse5 could not
 * round-trip it. The protocol degrades to DOM anchors, so the preview still
 * renders and selections still become mentions — they just lose line numbers.
 */
function injectBridgeByConcat(
  source: string,
  options: InstrumentPreviewHtmlOptions,
): string {
  const tag = bridgeTag(options, false);
  const headMatch = /<head[^>]*>/i.exec(source);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return source.slice(0, at) + tag + source.slice(at);
  }
  const htmlMatch = /<html[^>]*>/i.exec(source);
  if (htmlMatch) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return source.slice(0, at) + tag + source.slice(at);
  }
  return tag + source;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
