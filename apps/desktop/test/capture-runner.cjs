// Tool entry point only: electron-builder includes dist/ and renderer/, not test/.
// No flags, evaluators or fixture hooks are added to the production bridge.
const { app, nativeTheme } = require('electron');
const { readFileSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { Capture } = require('../../../scripts/desktop-capture/driver.mjs');
const { checkpoint } = require('../../../scripts/desktop-capture/options.mjs');
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
      const source = config.scenario.url ?? `data:text/javascript;base64,${Buffer.from(config.scenario.source).toString('base64')}`;
      const scenario = await import(source);
      if (typeof scenario.default !== 'function') throw new Error('Scenario must default-export an async generator function');
      const names = new Set();
      for await (const value of scenario.default(capture)) {
        if (report.captures.length >= 300) throw new Error('Run exceeds 300 checkpoints; split the scenario');
        const point = checkpoint(value, names);
        await capture.settle();
        const stem = `${String(report.captures.length + 1).padStart(3, '0')}-${point.name}`;
        const snapshot = await capture.inspect(point.inspect);
        const accessibility = await capture.accessibility();
        const params = { format: 'png', captureBeyondViewport: false };
        if (point.selector) {
          const rect = await capture.rect(point.selector);
          if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > config.width || rect.y + rect.height > config.height) throw new Error('Crop must fit in the viewport; scroll the element into view first');
          params.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
        }
        const { data } = await capture.cdp('Page.captureScreenshot', params);
        await writeFile(join(config.out, `${stem}.png`), Buffer.from(data, 'base64'));
        await writeFile(join(config.out, `${stem}.json`), JSON.stringify(snapshot, null, 2) + '\n');
        await writeFile(join(config.out, `${stem}.a11y.json`), JSON.stringify(accessibility, null, 2) + '\n');
        report.captures.push({ name: point.name, file: `${stem}.png`, snapshot: `${stem}.json`, accessibility: `${stem}.a11y.json`,
          viewport: snapshot.viewport, theme: config.theme, reducedMotion: config.reducedMotion, metadata: point.metadata, elapsedMs: Math.round(performance.now() - started) });
        console.log(`CAPTURE_IMAGE=${join(config.out, `${stem}.png`)}`);
      }
      if (!report.captures.length) throw new Error('Scenario yielded no checkpoints');
      if (report.errors.length) throw new Error(`Capture reported ${report.errors.length} renderer errors; see report.json`);
      report.verified = true;
      await save();
    })().catch(save);
  });
  require('../dist/main.js');
} catch (error) { console.error(error); app.exit(1); }
