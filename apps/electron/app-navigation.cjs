const { pathToFileURL } = require('node:url');

/** Angular routes use history/hash updates; document links belong outside the app. */
function installAppNavigation(webContents, frontendTarget, openExternal) {
  const entry = new URL(frontendTarget.kind === 'file'
    ? pathToFileURL(frontendTarget.value).href
    : frontendTarget.value);
  const open = (url) => { void Promise.resolve(openExternal(url)).catch(() => {}); };

  webContents.setWindowOpenHandler(({ url }) => {
    open(url);
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      // Permit reloading the entry document and its hash routes only. In
      // particular, file:// and matching HTTP origins are not blanket permits.
      if (target.protocol === entry.protocol && target.host === entry.host &&
          target.pathname === entry.pathname && target.search === entry.search) return;
    } catch { /* Invalid destinations must not replace the application either. */ }
    event.preventDefault();
    open(url);
  });
}

module.exports = { installAppNavigation };
