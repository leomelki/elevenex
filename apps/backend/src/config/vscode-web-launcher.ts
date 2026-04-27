const WORKBENCH_BOOTSTRAP_MARKER = '<!-- elevenex:workbench-bootstrap -->';

export function buildVSCodeWebLauncherHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>VS Code Web</title>
  <script>
    window.location.replace('./out/vs/code/browser/workbench/workbench.html' + window.location.search + window.location.hash);
  </script>
</head>
<body>
  <p>Redirecting to VS Code Web...</p>
</body>
</html>
`;
}

const WORKBENCH_BOOTSTRAP_SCRIPT = `${WORKBENCH_BOOTSTRAP_MARKER}
<script>
(function () {
  var params = new URLSearchParams(window.location.search);
  var workspace = params.get('workspace');
  var rawExtensionPaths = params.get('extensionPaths') || '';
  var extensionPaths = rawExtensionPaths.split(',').map(function (entry) { return entry.trim(); }).filter(Boolean);

  function toUri(value) {
    var url = new URL(value, window.location.origin);
    return {
      $mid: 1,
      scheme: url.protocol.replace(':', ''),
      authority: url.host,
      path: url.pathname === '' ? '/' : url.pathname,
      query: url.search ? url.search.slice(1) : '',
      fragment: url.hash ? url.hash.slice(1) : ''
    };
  }

  var product = {
    productConfiguration: {
      nameShort: 'Code - Web',
      nameLong: 'VS Code Web',
      applicationName: 'code-oss',
      dataFolderName: '.vscode-oss',
      version: '1.91.1',
      commit: 'f1e16e1e6214d7c44d078b1f0607b2388f29d729'
    },
    additionalBuiltinExtensions: extensionPaths.map(toUri),
    settingsSyncOptions: { enabled: false }
  };

  if (workspace) {
    product.folderUri = toUri(workspace);
  }

  window.product = product;

  function postReady() {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'vscode-workbench-ready' }, '*');
    }
  }

  var readyScheduled = false;
  function scheduleReady() {
    if (readyScheduled) return;
    readyScheduled = true;
    requestAnimationFrame(function () {
      requestAnimationFrame(postReady);
    });
  }

  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'vscode-workbench-check-ready') {
      // Reply to a parent probe even if we already signalled ready, so
      // reattached panels can resync without waiting for a new workbench.
      readyScheduled = false;
      if (document.querySelector('.monaco-workbench')) {
        scheduleReady();
      }
    }
  });

  function watchForWorkbench() {
    if (document.querySelector('.monaco-workbench')) {
      scheduleReady();
      return;
    }
    var target = document.body || document.documentElement;
    var observer = new MutationObserver(function () {
      if (document.querySelector('.monaco-workbench')) {
        observer.disconnect();
        scheduleReady();
      }
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchForWorkbench, { once: true });
  } else {
    watchForWorkbench();
  }
})();
</script>
`;

export interface RenderWorkbenchHtmlOptions {
  baseUrl?: string;
  nlsBaseUrl?: string;
}

export function renderVSCodeWorkbenchHtml(rawHtml: string, options: RenderWorkbenchHtmlOptions = {}): string {
  const baseUrl = options.baseUrl ?? '/vscode-static';
  const nlsBaseUrl = options.nlsBaseUrl ?? '';

  let html = rawHtml
    .replace(/\{\{WORKBENCH_WEB_BASE_URL\}\}/g, baseUrl)
    .replace(/\{\{WORKBENCH_WEB_CONFIGURATION\}\}/g, '{}')
    .replace(/\{\{WORKBENCH_AUTH_SESSION\}\}/g, '{}')
    .replace(/\{\{WORKBENCH_NLS_BASE_URL\}\}/g, nlsBaseUrl);

  if (html.includes(WORKBENCH_BOOTSTRAP_MARKER)) {
    return html;
  }

  const headCloseIndex = html.indexOf('</head>');
  if (headCloseIndex === -1) {
    return `${WORKBENCH_BOOTSTRAP_SCRIPT}\n${html}`;
  }

  return `${html.slice(0, headCloseIndex)}${WORKBENCH_BOOTSTRAP_SCRIPT}${html.slice(headCloseIndex)}`;
}
