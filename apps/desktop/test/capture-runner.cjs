// Tool entry point only: electron-builder includes dist/ and renderer/, not test/.
// No flags, evaluators or fixture hooks are added to the production bridge.
const { app, nativeTheme } = require('electron');
const { readFileSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { Capture } = require('../../../scripts/desktop-capture/driver.mjs');
const { runScenario } = require('../../../scripts/desktop-capture/scenario.mjs');
const { writeReport } = require('../../../scripts/desktop-capture/report.mjs');

// This bounded startup read must precede Electron readiness: production main
// registers its privileged protocol synchronously. Runtime I/O stays asynchronous.
const config = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
try {
  const report = { scenario: config.scenario.label, fixture: !!config.fixture, built: !!config.built,
    startupMs: config.startupMs, captures: [], errors: [], warnings: [], droppedDiagnostics: 0, verified: false };
  const started = performance.now();
  let capture;
  let window;
  let finished = false;
  const save = async failure => {
    if (finished) return;
    finished = true;
    if (failure) report.failure = String(failure.stack ?? failure)
      .replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, 'stdin-scenario.mjs').slice(0, 32000);
    report.totalMs = Math.round(performance.now() - started);
    // Write diagnostics before attempting a screenshot of a possibly hung renderer.
    await writeReport(config.out, report);
    try {
      if (failure && window && !window.isDestroyed()) {
        const image = await window.webContents.capturePage();
        await writeFile(join(config.out, 'failure.png'), image.toPNG());
        report.failureScreenshot = 'failure.png';
      }
    } catch (error) { report.warnings.push(`Failure screenshot: ${error.message}`); }
    try { await writeReport(config.out, report); }
    finally {
      capture?.dispose();
      app.exit(report.verified ? 0 : 1);
    }
  };
  process.once('SIGTERM', () => { void save(new Error('Capture cancelled or deadline exceeded')); });
  process.once('uncaughtException', error => { void save(error); });
  process.once('unhandledRejection', error => { void save(error); });
  // appData is overridden before production main chooses userData. Native state,
  // browser storage and caches cannot touch the user's running development app.
  app.setPath('appData', config.temporary);
  nativeTheme.themeSource = config.theme;
  if (config.url) process.env['ELEVENEX_RENDERER_URL'] = config.url;
  else delete process.env['ELEVENEX_RENDERER_URL'];
  app.once('browser-window-created', (_event, created) => {
    window = created;
    void (async () => {
      capture = new Capture(window, nativeTheme, config, report);
      window.webContents.once('render-process-gone', (_event, details) => { void save(new Error(`Renderer exited: ${details.reason}`)); });
      // Main starts loadURL immediately after this event. Debug domains attach
      // synchronously in the constructor so startup errors are observed too.
      const loaded = new Promise((resolveLoad, reject) => {
        window.webContents.once('did-finish-load', resolveLoad);
        window.webContents.once('did-fail-load', (_event, code, message) => reject(new Error(`${code}: ${message}`)));
      });
      await capture.initialize();
      await loaded;
      await capture.theme(config.theme);
      await capture.settle();
      await runScenario(capture, config, report, started);
      report.verified = true;
      await save();
    })().catch(save);
  });
  require('../dist/main.js');
} catch (error) { console.error(error); app.exit(1); }
