import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpoint } from './options.mjs';

/** Execute one scenario against the existing capture; retain every completed artifact. */
export async function runScenario(capture, config, report, started) {
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
}
