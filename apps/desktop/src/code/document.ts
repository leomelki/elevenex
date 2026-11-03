import { randomBytes } from 'node:crypto';
import type { WorkspaceDescriptor } from './validation';
// v2 escapes immutable extension responses emitted by the original iframe host.
// These app-owned assets are now no-store; pinned upstream assets stay cached.
export const CODE_EXTENSION_PATH = '/extension-v2';
export const EXTENSION = {
  name: 'task-workspace', publisher: 'elevenex', version: '1.1.0', displayName: 'Elevenex task workspace',
  engines: { vscode: '^1.144.0' }, browser: './extension.js', activationEvents: ['onFileSystem:elevenex-task', '*'],
  enabledApiProposals: ['fileSearchProvider', 'textSearchProvider'],
  capabilities: { virtualWorkspaces: true, untrustedWorkspaces: { supported: true } },
  contributes: {
    viewsContainers: { secondarySidebar: [{ id: 'elevenex-files', title: 'Files', icon: '$(files)' }] },

    commands: [{ command: 'elevenex.code.browse-files', title: 'Browse task files', icon: '$(files)' }, { command: 'elevenex.code.dismiss-files', title: 'Back to editor (Esc)', icon: '$(arrow-left)' }, { command: 'elevenex.code.reconnect', title: 'Reconnect task workspace' }, { command: 'elevenex.code.reconcile-save', title: 'Inspect unconfirmed task save' }, { command: 'elevenex.code.return-to-chat', title: 'Return to chat', enablement: 'elevenex.embedded' }],
    keybindings: [{ command: 'list.toggleExpand', key: 'enter', mac: 'enter', when: 'elevenex.compactFiles && filesExplorerFocus && explorerResourceIsFolder && !inputFocus' }, { command: 'explorer.openAndPassFocus', key: 'enter', mac: 'enter', when: 'elevenex.compactFiles && filesExplorerFocus && !explorerResourceIsFolder && !inputFocus' }, { command: 'elevenex.code.browse-files', key: 'ctrl+shift+e', mac: 'cmd+shift+e', when: 'elevenex.compact' }, { command: 'elevenex.code.browse-files', key: 'ctrl+b', mac: 'cmd+b', when: 'elevenex.compact' }, { command: 'elevenex.code.dismiss-files', key: 'ctrl+b', mac: 'cmd+b', when: 'elevenex.compactFiles && elevenex.hasEditors' }, { command: 'elevenex.code.dismiss-files', key: 'escape', when: 'elevenex.compactFiles && elevenex.hasEditors && !inputFocus && !contextMenuVisible && !listFindWidgetVisible' }, { command: 'workbench.action.quickTextSearch', key: 'ctrl+shift+f', mac: 'cmd+shift+f', when: 'elevenex.compact' }, { command: 'elevenex.code.return-to-chat', key: 'ctrl+shift+r', mac: 'cmd+shift+r', when: 'elevenex.embedded' }],
  },
};
export function codePolicy(authority: string, nonce: string, extensionWorker = false, hashes: readonly string[] = [], shellOrigin = 'app://elevenex'): string {
  // Upstream CommonJS web extensions are evaluated only in the separate worker
  // origin. The application shell and workbench main document never gain eval.
  return ["default-src 'none'", `script-src 'self' https://${authority} https://*.${authority} 'nonce-${nonce}' 'wasm-unsafe-eval'${extensionWorker ? " 'unsafe-eval'" : ''}${hashes.map(hash => ` 'sha256-${hash}'`).join('')}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'", "worker-src 'self' blob:", `connect-src 'self' https://*.${authority} https://${authority}`, `frame-src https://*.${authority}`, "base-uri 'none'", "object-src 'none'", `frame-ancestors 'self' https://${authority} ${shellOrigin}`, "form-action 'none'"].join('; ');
}
function colors(css: string, dark: boolean): Record<string, string> {
  const block = dark ? css.match(/\[data-theme="dark"\]\s*\{([^}]+)/)?.[1] : css.match(/:root,\s*\[data-theme="light"\]\s*\{([^}]+)/)?.[1];
  return Object.fromEntries([...((block ?? '').matchAll(/--([a-z-]+):\s*(#[a-fA-F0-9]+);/g))].map(m => [m[1]!, m[2]!]));
}
export function workbenchDocument(workspace: WorkspaceDescriptor, authority: string, tokens: string, dark: boolean, shellOrigin = 'app://elevenex'): { html: string; policy: string } {
  const nonce = randomBytes(18).toString('base64'), palette = colors(tokens, dark);
  const uiColors = (palette: Record<string, string>) => ({
    'editor.background': palette['surface'], 'editor.foreground': palette['ink'], 'sideBar.background': palette['surface-sunken'], 'sideBar.foreground': palette['ink'],
    'activityBar.background': palette['surface'], 'activityBar.foreground': palette['ink'], 'activityBarBadge.background': palette['accent'], 'activityBarBadge.foreground': palette['on-accent'],
    'statusBar.background': palette['surface-sunken'], 'statusBar.foreground': palette['ink-muted'], 'statusBar.noFolderBackground': palette['surface-sunken'], 'statusBarItem.remoteBackground': palette['surface-sunken'], 'statusBarItem.remoteForeground': palette['ink-muted'], 'titleBar.activeBackground': palette['surface'], 'titleBar.activeForeground': palette['ink-muted'], 'titleBar.inactiveBackground': palette['surface'], 'titleBar.inactiveForeground': palette['ink-muted'],
    'editorGroupHeader.tabsBackground': palette['surface-sunken'], 'tab.activeBackground': palette['surface'], 'tab.activeForeground': palette['ink'], 'tab.inactiveForeground': palette['ink-muted'],
    'focusBorder': palette['accent'], 'button.background': palette['accent'], 'button.foreground': palette['on-accent'],
    'input.background': palette['surface-raised'], 'input.foreground': palette['ink'], 'input.border': palette['line'], 'panel.background': palette['surface'], 'panel.border': palette['line'],
    'input.placeholderForeground': palette['ink-muted'], 'inputOption.activeBackground': palette['accent-soft'], 'inputOption.activeBorder': palette['accent'],
    'list.activeSelectionBackground': palette['accent-soft'], 'list.activeSelectionForeground': palette['ink'], 'list.inactiveSelectionBackground': palette['surface-sunken'], 'list.inactiveSelectionForeground': palette['ink'],
    'list.focusBackground': palette['accent-soft'], 'list.focusForeground': palette['ink'], 'list.highlightForeground': palette['accent'], 'list.focusOutline': palette['accent'],
    'quickInput.background': palette['surface-raised'], 'quickInput.foreground': palette['ink'], 'quickInputList.focusBackground': palette['accent-soft'], 'quickInputList.focusForeground': palette['ink'],
    'editor.selectionBackground': palette['accent-soft'], 'editor.selectionForeground': palette['ink'], 'editor.lineHighlightBackground': palette['surface-sunken'], 'editor.lineHighlightBorder': palette['surface-sunken'],
    'editorLineNumber.foreground': palette['ink-muted'], 'editorLineNumber.activeForeground': palette['ink'], 'editorGroup.border': palette['line'], 'tab.inactiveBackground': palette['surface-sunken'],
    'badge.background': palette['accent-soft'], 'badge.foreground': palette['accent'], 'progressBar.background': palette['accent'], 'sash.hoverBorder': palette['accent'],
  });
  const syntaxColors = (palette: Record<string, string>) => ({ comments: palette['ink-muted'], strings: palette['code-string'], keywords: palette['code-keyword'], numbers: palette['code-number'], functions: palette['code-function'], types: palette['code-function'], variables: palette['ink'] });
  // In web, layout controls force the custom title bar to remain visible even
  // with the command center off. Disabling them lets upstream reclaim its row;
  // window.customTitleBarVisibility is a desktop-only setting.
  const options = {
    workspace: { folderUri: { scheme: 'elevenex-task', authority: workspace.storageIdentity, path: '/' } },
    additionalBuiltinExtensions: [{ scheme: 'https', authority, path: CODE_EXTENSION_PATH }],
    enabledExtensionProposedApi: ['elevenex.task-workspace'],
    productConfiguration: { nameShort: 'Code OSS', nameLong: 'Code OSS', applicationName: 'elevenex-code', quality: 'stable', commit: 'elevenex-code-oss-1.144.0', enableTelemetry: false, webEndpointUrlTemplate: `https://{{uuid}}.${authority}`, extensionEnabledApiProposals: { 'elevenex.task-workspace': ['fileSearchProvider', 'textSearchProvider'] } },
    configurationDefaults: { 'telemetry.telemetryLevel': 'off', 'chat.disableAIFeatures': true, 'chat.agentFilesLocations': {}, 'chat.agentSkillsLocations': {}, 'chat.instructionsFilesLocations': {}, 'chat.hookFilesLocations': {}, 'chat.useAgentSkills': false, 'chat.useHooks': false, 'chat.useClaudeHooks': false, 'workbench.startupEditor': 'none', 'workbench.tips.enabled': false, 'workbench.colorTheme': dark ? 'Dark Modern' : 'Light Modern', 'workbench.colorCustomizations': { '[Dark Modern]': uiColors(colors(tokens, true)), '[Light Modern]': uiColors(colors(tokens, false)) }, 'editor.tokenColorCustomizations': { '[Dark Modern]': syntaxColors(colors(tokens, true)), '[Light Modern]': syntaxColors(colors(tokens, false)) }, 'window.autoDetectColorScheme': false, 'workbench.preferredDarkColorTheme': 'Dark Modern', 'workbench.preferredLightColorTheme': 'Light Modern', 'editor.fontFamily': '"Geist Mono", monospace', 'editor.fontSize': 12.5, 'editor.editContext': false, 'editor.experimentalGpuAcceleration': 'off', 'editor.minimap.enabled': false, 'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 1000, 'files.hotExit': 'onExitAndWindowClose', 'window.menuBarVisibility': 'compact', 'window.titleBarStyle': 'custom', 'window.commandCenter': false, 'workbench.layoutControl.enabled': false, 'window.title': 'Code', 'chat.microsoftAuthentication.enabled': false, 'security.workspace.trust.enabled': false, 'search.followSymlinks': false, 'extensions.ignoreRecommendations': true },
    windowIndicator: { label: '$(code)', tooltip: 'Task workspace' },
    defaultLayout: { views: [{ id: 'workbench.explorer.fileView' }] },
    enableWorkspaceTrust: false,
  };
  const json = JSON.stringify(options).replaceAll('<', '\\u003c');
  return { policy: codePolicy(authority, nonce, false, [], shellOrigin), html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Code OSS</title><link rel="icon" href="/assets/favicon.ico"><link rel="stylesheet" href="/assets/out/vs/workbench/workbench.web.main.internal.css"><style nonce="${nonce}">html,body{height:100%;margin:0;background:${palette['surface']}}@font-face{font-family:'Geist Mono';src:url('/fonts/geist-mono.woff2');font-weight:100 900;font-display:swap}@font-face{font-family:'Instrument Sans';src:url('/fonts/instrument-sans.woff2');font-weight:100 900;font-display:swap}body,.monaco-workbench{font-family:'Instrument Sans',sans-serif}</style></head><body></body><script nonce="${nonce}" type="module">void navigator.storage.persist().catch(()=>false);globalThis._VSCODE_FILE_ROOT=location.origin+'/assets/out/';await import('/assets/out/nls.messages.js');const [{create,URI,commands},{FilesFocus}]=await Promise.all([import('/assets/out/vs/workbench/workbench.web.main.internal.js'),import('${CODE_EXTENSION_PATH}/files-focus.browser.js')]);const filesFocus=new FilesFocus(document,()=>commands.executeCommand('elevenex.code.dismiss-files'));addEventListener('pagehide',()=>filesFocus.dispose(),{once:true});const config=${json};const initial=config.workspace;initial.folderUri=URI.from(initial.folderUri);delete config.workspace;create(document.body,{...config,commands:[{id:'elevenex.code.files-layout',handler:(browsing)=>{if(typeof browsing==='boolean')filesFocus.setBrowsing(browsing);}}],workspaceProvider:{workspace:initial,trusted:true,open:async()=>false}});</script></html>` };
}
