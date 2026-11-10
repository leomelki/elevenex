import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { screen } = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))('electron');

/** Replay zsh's 80-column PROMPT_SP startup through the production ANSI adapter. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/terminal-rendering'; });
  await capture.waitFor(() => document.querySelector('.terminal[data-ready=true]'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.reducedMotion(theme === 'dark');
    // Match device-pixel ResizeObserver boxes to the native display, like the
    // terminal-rendering regression, so WebGL's viewport and canvas agree.
    await capture.cdp('Emulation.setDeviceMetricsOverride', {
      width: 420, height: 600, deviceScaleFactor: screen.getPrimaryDisplay().scaleFactor, mobile: false,
    });
    await capture.settle();
    const result = await capture.component('ex-terminal-rendering-demo', async component => {
      const surface = component.surface;
      const host = surface.terminal.element.parentElement;
      const size = { cols: surface.terminal.cols, rows: surface.terminal.rows };
      surface.reset();
      surface.detach();
      surface.attach(host, true, true);
      const startup = '\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m' + ' '.repeat(79) +
        '\r \r\r\x1b[0m\x1b[27m\x1b[24m\x1b[JREADY> \x1b[K';
      await surface.write(startup, { cols: 80, rows: 24 }, true);
      const replay = { row: surface.terminal.buffer.active.cursorY, cols: surface.terminal.cols };
      // Detach between pages, as when switching away and back during catch-up.
      surface.detach();
      surface.attach(host, true, true);
      await surface.write('\r\x1b[2KREADY> ', size);
      return { replay, size, row: surface.terminal.buffer.active.cursorY,
        firstLine: surface.terminal.buffer.active.getLine(0).translateToString(true) };
    });
    assert(result.size.cols < 80, 'The visible pane must be narrower than the startup grid');
    assert.deepEqual(result.replay, { row: 0, cols: 80 });
    assert.equal(result.row, 0, 'The first prompt must start at the top');
    assert.equal(result.firstLine, 'READY> ');
    await capture.settle();
    yield { name: `${theme}-startup`, selector: '.terminal[data-ready]', metadata: result };

    await capture.component('ex-terminal-rendering-demo', component => component.surface.focus());
    await capture.press('x');
    assert.equal(await capture.component('ex-terminal-rendering-demo', component => component.input()), theme === 'light' ? 'x' : 'xx');
    const retained = await capture.component('ex-terminal-rendering-demo', async component => {
      const surface = component.surface;
      await surface.write('\r\n\r\nintentional blank line\r\n');
      const blank = surface.terminal.buffer.active.getLine(1).translateToString(true);
      await surface.write(Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\r\n'));
      surface.terminal.scrollToBottom();
      return { blank, top: surface.terminal.buffer.active.getLine(surface.terminal.buffer.active.baseY).translateToString(true) };
    });
    assert.equal(retained.blank, '', 'Intentional blank lines must be preserved');
    assert.match(retained.top, /^line \d+/, 'Scrolled output must use the first visible row');
    yield { name: `${theme}-filled`, selector: '.terminal[data-ready]', metadata: retained };
  }
}
