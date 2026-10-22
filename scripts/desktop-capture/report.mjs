import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export async function writeReport(out, report) {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const cards = report.captures.map(point => `<figure><a href="${point.file}"><img src="${point.file}" loading="lazy" alt="${escapeHtml(point.name)}"></a>
    <figcaption>${escapeHtml(point.name)} · ${point.viewport.width}×${point.viewport.height} · ${escapeHtml(point.theme)}
    <a href="${point.snapshot}">State / layout / focus</a> · <a href="${point.accessibility}">Accessibility</a></figcaption></figure>`).join('\n');
  await writeFile(join(out, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Elevenex capture</title>
    <style>:root{color-scheme:light dark}body{font:14px system-ui;margin:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:24px}figure{margin:0}img{width:100%;height:auto;border:1px solid GrayText}figcaption{padding:8px 0}a{color:LinkText}pre{white-space:pre-wrap}h1{font-size:20px}</style>
    <h1>${report.verified ? 'Verified' : 'Failed'} · ${escapeHtml(report.scenario)}${report.fixture ? ' · Verification fixture (not product UI)' : ''}</h1>
    <p>${report.captures.length} checkpoints · ${report.startupMs}ms startup · ${report.totalMs}ms scenario · <a href="report.json">Full diagnostics</a></p>
    ${report.failure ? `<pre>${escapeHtml(report.failure)}</pre>` : ''}
    ${report.failureScreenshot ? '<p><a href="failure.png">Failure screenshot</a></p>' : ''}<main>${cards}</main>
    <details><summary>Errors (${report.errors.length}) / warnings (${report.warnings.length})</summary><pre>${escapeHtml([...report.errors, ...report.warnings].join('\n'))}</pre></details></html>`);
}
