import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { nativeImage, screen } = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))('electron');

export default async function* (capture) {
  // Device-pixel ResizeObserver boxes use the native display density in Chromium,
  // even under CDP's 1x emulation. Keep both densities aligned for canvas captures.
  const density = screen.getPrimaryDisplay().scaleFactor;
  const viewport = async (width, height) => {
    await capture.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: density, mobile: false });
    await capture.settle();
  };
  const owner = operation => capture.component('ex-terminal-rendering-demo', operation);
  await capture.waitFor(() => document.querySelector('.terminal[data-ready=true]') && !document.querySelector('vite-error-overlay'));

  async function geometry() {
    await capture.waitFor(() => {
      const canvas = document.querySelector('.xterm-screen > canvas:last-of-type');
      const gl = canvas?.getContext('webgl2');
      if (!gl) return false;
      const viewport = gl.getParameter(gl.VIEWPORT);
      return Math.abs(viewport[2] - canvas.width) <= 1 && Math.abs(viewport[3] - canvas.height) <= 1;
    });
    const grid = await owner(component => {
      const terminal = component.surface.terminal;
      const canvas = terminal.element.querySelector('.xterm-screen > canvas:last-of-type');
      const gl = canvas.getContext('webgl2');
      return {
        rect: canvas.getBoundingClientRect().toJSON(), cols: terminal.cols, rows: terminal.rows,
        viewport: [...gl.getParameter(gl.VIEWPORT)], width: canvas.width, height: canvas.height,
        cap: terminal.buffer.active.getLine(0).translateToString().indexOf('\ue0b4'),
      };
    });
    assert(Math.abs(grid.viewport[2] - grid.width) <= 1 && Math.abs(grid.viewport[3] - grid.height) <= 1,
      'Canvas viewport must match its backing buffer within device-pixel rounding');
    const cw = grid.rect.width / grid.cols, ch = grid.rect.height / grid.rows;
    const { data } = await capture.cdp('Page.captureScreenshot', {
      format: 'png', clip: { x: grid.rect.x, y: grid.rect.y, width: (grid.cap + 2) * cw, height: 7 * ch, scale: 1 },
    });
    const image = nativeImage.createFromDataURL(`data:image/png;base64,${data}`);
    const bitmap = image.toBitmap(), size = image.getSize();
    const scale = size.width / ((grid.cap + 2) * cw);
    const rgb = (x, y) => {
      const offset = (Math.floor(y * scale) * size.width + Math.floor(x * scale)) * 4;
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
    };
    // Compare to a filled, blank prompt cell, allowing edge antialiasing and the
    // host's native-image color conversion rather than requiring literal RGB bytes.
    const fill = rgb(cw * 1.5, ch * .5);
    const magenta = color => color.every((channel, index) => Math.abs(channel - fill[index]) < 40);
    assert(magenta(rgb(cw - 1, ch * .1)), 'Left rounded cap must reach the top cell edge');
    assert(magenta(rgb(cw - 1, ch * .9)), 'Left rounded cap must reach the bottom cell edge');
    assert(!magenta(rgb(.5, .5)), 'Left cap corner must stay rounded');
    assert(magenta(rgb((grid.cap + .1) * cw, ch * .1)), 'Right cap must meet the background above the baseline');
    assert(magenta(rgb((grid.cap + .1) * cw, ch * .9)), 'Right cap must meet the background below the baseline');
    return { cols: grid.cols, rows: grid.rows, cellWidth: cw, cellHeight: ch };
  }

  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await viewport(1000, 600);
    for (const [name, height, spacing] of [['compact', 1, 0], ['default', 1.6, 0], ['spaced', 2, 2]]) {
      await capture.component('ex-terminal-rendering-demo', (component, values) => component.metrics(...values), [height, spacing]);
      await capture.settle();
      const metrics = await geometry();
      yield { name: `${theme}-${name}`, selector: '.terminal[data-ready]', metadata: metrics };
    }
    await owner(component => component.surface.focus());
    await capture.press('x');
    assert.equal(await owner(component => component.input()), theme === 'light' ? 'x' : 'xx');
    assert.equal(await owner(component => component.surface.search('rounded').matches), 1);
    assert.equal(await owner(component => component.surface.terminal.getSelection()), 'rounded');
    const retained = await owner(component => {
      const surface = component.surface, host = surface.terminal.element.parentElement;
      const canvas = surface.terminal.element.querySelector('.xterm-screen > canvas:last-of-type');
      const context = canvas.getContext('webgl2'), before = surface.context();
      surface.detach();
      const released = context.isContextLost();
      surface.attach(host, true);
      return { released, sameOutput: surface.context() === before, selection: surface.terminal.getSelection() };
    });
    assert.deepEqual(retained, { released: true, sameOutput: true, selection: 'rounded' });
    await capture.settle();
    await geometry();
    await owner(component => component.surface.terminal.clearSelection());
    await capture.reducedMotion(true);
    await viewport(420, 600);
    await capture.component('ex-terminal-rendering-demo', component => component.metrics(1.6, 0));
    await capture.settle();
    yield { name: `${theme}-narrow`, selector: '.terminal[data-ready]' };
    await capture.reducedMotion(false);
  }

  await viewport(1000, 600);
  await owner(component => {
    const canvas = component.surface.terminal.element.querySelector('.xterm-screen > canvas:last-of-type');
    canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
  });
  await capture.waitFor(() => document.querySelector('.xterm-rows'));
  await owner(component => component.surface.focus());
  await capture.press('y');
  assert.equal(await owner(component => component.input()), 'xxy');
  assert((await owner(component => component.surface.context())).includes('box drawing'));
  yield { name: 'gpu-loss-fallback', selector: '.terminal[data-ready]' };
}
