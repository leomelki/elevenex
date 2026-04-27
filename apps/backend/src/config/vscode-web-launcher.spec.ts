import {
  buildVSCodeWebLauncherHtml,
  renderVSCodeWorkbenchHtml,
} from './vscode-web-launcher.js';

describe('buildVSCodeWebLauncherHtml', () => {
  it('redirects to the VS Code workbench', () => {
    const html = buildVSCodeWebLauncherHtml();

    expect(html).toContain('./out/vs/code/browser/workbench/workbench.html');
  });

  it('preserves the full search string and hash fragment', () => {
    const html = buildVSCodeWebLauncherHtml();

    expect(html).toContain('window.location.search');
    expect(html).toContain('window.location.hash');
  });
});

describe('renderVSCodeWorkbenchHtml', () => {
  const template = `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="{{WORKBENCH_WEB_BASE_URL}}/out/vs/workbench/workbench.web.main.css">
  <meta id="vscode-workbench-web-configuration" data-settings="{{WORKBENCH_WEB_CONFIGURATION}}">
  <meta id="vscode-workbench-auth-session" data-settings="{{WORKBENCH_AUTH_SESSION}}">
  <script>const nls = '{{WORKBENCH_NLS_BASE_URL}}';</script>
</head>
<body></body>
<script src="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/workbench.js"></script>
</html>`;

  it('substitutes the base URL placeholder everywhere', () => {
    const html = renderVSCodeWorkbenchHtml(template);

    expect(html).not.toContain('{{WORKBENCH_WEB_BASE_URL}}');
    expect(html).toContain('/vscode-static/out/vs/workbench/workbench.web.main.css');
    expect(html).toContain('/vscode-static/out/vs/code/browser/workbench/workbench.js');
  });

  it('replaces auth, nls, and configuration placeholders with safe defaults', () => {
    const html = renderVSCodeWorkbenchHtml(template);

    expect(html).not.toContain('{{WORKBENCH_WEB_CONFIGURATION}}');
    expect(html).not.toContain('{{WORKBENCH_AUTH_SESSION}}');
    expect(html).not.toContain('{{WORKBENCH_NLS_BASE_URL}}');
    expect(html).toContain('data-settings="{}"');
  });

  it('injects a client bootstrap that builds window.product from the query string', () => {
    const html = renderVSCodeWorkbenchHtml(template);

    expect(html).toContain('window.product');
    expect(html).toContain("params.get('workspace')");
    expect(html).toContain("params.get('extensionPaths')");
    expect(html).toContain('additionalBuiltinExtensions');
  });

  it('wires a workbench-ready signal the parent frame can listen for', () => {
    const html = renderVSCodeWorkbenchHtml(template);

    expect(html).toContain("'vscode-workbench-ready'");
    expect(html).toContain("'vscode-workbench-check-ready'");
    expect(html).toContain('.monaco-workbench');
    expect(html).toContain('MutationObserver');
  });

  it('is idempotent when rendered twice', () => {
    const first = renderVSCodeWorkbenchHtml(template);
    const second = renderVSCodeWorkbenchHtml(first);

    expect(second).toEqual(first);
  });

  it('allows overriding the base URL', () => {
    const html = renderVSCodeWorkbenchHtml(template, { baseUrl: '/custom/base' });

    expect(html).toContain('/custom/base/out/vs/workbench/workbench.web.main.css');
  });
});
