import { buildVSCodeUploadProgressScript } from './vscode-web-upload.js';

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
  var theme = params.get('theme') === 'light' ? 'light' : 'dark';

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
      commit: 'f1e16e1e6214d7c44d078b1f0607b2388f29d729',
      extensionEnabledApiProposals: {
        'elevenex.elevenex-filesystem-provider': ['textSearchProvider']
      }
    },
    additionalBuiltinExtensions: extensionPaths.map(toUri),
    settingsSyncOptions: { enabled: false },
    configurationDefaults: {
      'workbench.colorTheme': theme === 'light' ? 'Default Light Modern' : 'Default Dark Modern'
    }
  };

  if (workspace) {
    product.folderUri = toUri(workspace);
  }

  window.product = product;

  var generation = params.get('generation') || '';
  var requestId = '';
  var workbenchReady = false;
  var fileBridgeReady = false;
  var workspaceReady = false;
  var startupError = '';
  var fileBridge = null;
  var pendingFileRequests = [];
  var pendingTheme = null;
  var observer = null;
  var startupTimer = null;
  var cancelled = false;

  function post(type, extra) {
    if (window.parent !== window && requestId) window.parent.postMessage(Object.assign({ type: type, generation: generation, requestId: requestId }, extra || {}), '*');
  }
  function report() {
    if (startupError) { post('elevenex-editor-startup-error', { message: startupError }); return; }
    if (workbenchReady) post('elevenex-editor-stage', { stage: 'workbench' });
    if (fileBridgeReady) post('elevenex-editor-stage', { stage: 'bridge' });
    if (workbenchReady && fileBridgeReady && workspaceReady && !cancelled) {
      clearTimeout(startupTimer);
      post('vscode-workbench-ready', { bridgeReady: true, workspaceReady: true });
    }
  }
  function fail(message) {
    startupError = message;
    clearTimeout(startupTimer);
    if (observer) observer.disconnect();
    if (fileBridge) fileBridge.postMessage({ type: 'elevenex-editor-cancel' });
    report();
  }
  function probe() {
    if (!fileBridge) { fail('The filesystem bridge is unavailable in this browser.'); return; }
    fileBridge.postMessage({ type: 'elevenex-file-bridge-probe', requestId: requestId });
  }

  if (workspace && typeof BroadcastChannel !== 'undefined') {
    try {
      var workspaceUrl = new URL(workspace, window.location.origin);
      var workspacePath = workspaceUrl.searchParams.get('worktreePath') || decodeURIComponent(workspaceUrl.host || workspaceUrl.pathname);
      fileBridge = new BroadcastChannel('elevenex-vscode:' + workspacePath + ':' + generation);
      fileBridge.addEventListener('message', function (event) {
        var data = event.data;
        if (!data) return;
        if (data.type === 'elevenex-editor-check-result') {
          window.parent.postMessage(data, '*');
          return;
        }
        if (cancelled) return;
        if (data.type === 'elevenex-file-bridge-ready') {
          fileBridgeReady = true;
          if (pendingTheme) fileBridge.postMessage(pendingTheme);
          probe();
          report();
        } else if (data.type === 'elevenex-workspace-ready' && data.requestId === requestId) {
          fileBridgeReady = true;
          workspaceReady = true;
          pendingFileRequests.splice(0).forEach(function (request) { fileBridge.postMessage(request); });
          report();
        } else if (data.type === 'elevenex-editor-sync-error') {
          workspaceReady = false;
          post(data.type, { message: data.message });
        } else if (data.type === 'elevenex-editor-file-changes') {
          post(data.type, { changes: data.changes });
        } else if (data.type === 'elevenex-editor-reconnected') {
          probe();
        }
      });
    } catch (error) { fail('Could not initialize the filesystem bridge.'); }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || !event.data) return;
    var data = event.data;
    if (data.generation && data.generation !== generation) return;
    if (data.type === 'vscode-workbench-check-ready') {
      requestId = data.requestId;
      cancelled = false;
      clearTimeout(startupTimer);
      startupTimer = setTimeout(function () { fail('The workbench or filesystem extension did not become ready. Retry the connection.'); }, 28000);
      probe();
      report();
    } else if (data.type === 'elevenex-editor-cancel') {
      cancelled = true;
      clearTimeout(startupTimer);
      pendingFileRequests.length = 0;
      if (fileBridge) fileBridge.postMessage(data);
      // Stop pending runtime requests too, without destroying loaded documents.
      window.stop();
    } else if (data.type === 'elevenex-editor-theme') {
      pendingTheme = data;
      if (fileBridgeReady) fileBridge.postMessage(data);
    } else if (data.type === 'elevenex-editor-retry') {
      cancelled = false;
      startupError = '';
      if (fileBridge) fileBridge.postMessage(data);
    } else if (data.type === 'elevenex-editor-check') {
      // Release checks must work even after a failed startup attempt.
      if (fileBridge) fileBridge.postMessage(data);
    } else if (data.type === 'elevenex-editor-visibility') {
      if (!data.visible) clearTimeout(startupTimer);
      if (fileBridge) fileBridge.postMessage(data);
    } else if (data.type === 'elevenex-open-file') {
      if (!fileBridge || cancelled) return;
      if (workspaceReady) fileBridge.postMessage(data);
      else { pendingFileRequests.length = 0; pendingFileRequests.push(data); }
    }
  });

  window.addEventListener('error', function (event) {
    if (event.target && (event.target.tagName === 'SCRIPT' || event.target.tagName === 'LINK')) fail('A required editor runtime asset failed to load. Retry the connection.');
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var message = String(event.reason && event.reason.message || event.reason);
    // VS Code probes workspace configuration before the lazy filesystem
    // provider has activated. These expected failures must not cancel it.
    if (!workspaceReady && !cancelled && !/ENOPRO|Canceled|Cancelled|EntryNotFound|FileNotFound/.test(message)) {
      fail('An editor extension or runtime failed during startup: ' + message.slice(0, 200));
    }
  });
  window.addEventListener('pagehide', function () {
    clearTimeout(startupTimer);
    if (observer) observer.disconnect();
    if (fileBridge) fileBridge.close();
    pendingFileRequests.length = 0;
  }, { once: true });

  function watchForWorkbench() {
    function check() {
      if (!document.querySelector('.monaco-workbench')) return false;
      workbenchReady = true;
      if (observer) observer.disconnect();
      report();
      return true;
    }
    if (check()) return;
    observer = new MutationObserver(check);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchForWorkbench, { once: true });
  else watchForWorkbench();
})();
</script>
`;

export interface RenderWorkbenchHtmlOptions {
  baseUrl?: string;
  nlsBaseUrl?: string;
}

export function renderVSCodeWorkbenchHtml(
  rawHtml: string,
  options: RenderWorkbenchHtmlOptions = {},
): string {
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

  // Load the adapter after the AMD workbench modules are defined, before the
  // entrypoint creates the workbench and can accept dropped files.
  html = html.replace(
    /<script\b[^>]*\bsrc="[^"]*\/vs\/code\/browser\/workbench\/workbench\.js"[^>]*>/,
    (entrypoint) => buildVSCodeUploadProgressScript() + entrypoint,
  );

  const headCloseIndex = html.indexOf('</head>');
  if (headCloseIndex === -1) {
    return `${WORKBENCH_BOOTSTRAP_SCRIPT}\n${html}`;
  }

  return `${html.slice(0, headCloseIndex)}${WORKBENCH_BOOTSTRAP_SCRIPT}${html.slice(headCloseIndex)}`;
}
