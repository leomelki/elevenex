export const HTML_PREVIEW_EXTENSION = 'elevenex.task-workspace';
export const HTML_PREVIEW_VIEW = 'elevenex.htmlPreview';

// Preview styles can be inline. The private session routes stylesheet URLs
// through the same checkout allowlist as other resources.
export const STATIC_PREVIEW_POLICY = "script-src 'none'; connect-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'";

const PREVIEW_ASSETS = '/assets/out/vs/workbench/contrib/webview/browser/pre';

export function codeWebviewEndpoint(authority: string): string {
  return `https://{{uuid}}.preview.${authority}${PREVIEW_ASSETS}/`;
}

// Code OSS puts a base-32 hash of the parent origin and webview ID in the
// first label. A separate suffix keeps previews outside the task API origins.
export function isCodeWebviewOrigin(url: URL, authority: string): boolean {
  const suffix = `.preview.${authority}`;
  return url.protocol === 'https:' && !url.port && !url.username && !url.password
    && url.hostname.endsWith(suffix) && /^[0-9a-v]{52}$/.test(url.hostname.slice(0, -suffix.length));
}

export function codeWebviewAsset(url: URL, authority: string): 'index.html' | 'fake.html' | 'service-worker.js' | undefined {
  if (!isCodeWebviewOrigin(url, authority) || !url.pathname.startsWith(PREVIEW_ASSETS + '/')) return undefined;
  const name = url.pathname.slice(PREVIEW_ASSETS.length + 1);
  if (name === 'index.html') {
    if (['vscode.markdown-language-features', HTML_PREVIEW_EXTENSION].includes(url.searchParams.get('extensionId') ?? '')
      && url.searchParams.get('parentOrigin') === `https://${authority}`) return name;
  } else if (name === 'fake.html' || name === 'service-worker.js') return name;
  return undefined;
}

export function isMarkdownPreviewResource(url: URL, authority: string): boolean {
  if (url.origin !== `https://${authority}`) return false;
  // Upstream keeps HTTPS extension asset URLs on the workbench origin. Scope
  // preview reads to the pinned renderers and fonts these built-ins supply.
  const path = url.pathname;
  return /^\/assets\/extensions\/markdown-language-features\/media\/[\w-]+\.(js|css)$/.test(path)
    || /^\/assets\/extensions\/markdown-math\/(notebook-out|preview-styles)\/[\w.-]+\.css$/.test(path)
    || /^\/assets\/extensions\/markdown-math\/notebook-out\/fonts\/[\w-]+\.(woff2?|ttf)$/.test(path)
    || /^\/assets\/extensions\/mermaid-markdown-features\/markdown-preview-out\/[\w-]+\.(js|css)$/.test(path);
}

export function codeWebviewPolicy(authority: string, shellOrigin: string): string {
  // Code OSS supplies script CSP for the bootstrap and the rendered document.
  // The preview service worker serves synthetic resource URLs through Code OSS.
  return `frame-ancestors 'self' https://${authority} ${shellOrigin}; object-src 'none'; form-action 'none'; connect-src 'none'`;
}
