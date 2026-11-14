import { afterEach, expect, it, vi } from 'vitest';
import { NativePageLayout } from './native-page-layout';
import type { TaskBrowserLayout } from '@elevenex/shared';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const host = document.createElement('section'), surface = document.createElement('div'), overlays = document.createElement('div');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  host.append(surface); document.body.append(host, overlays);
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 600, 400));
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  const send = vi.fn<(input: Omit<TaskBrowserLayout, 'surfaceEpoch' | 'ownerGeneration'>) => Promise<void>>().mockResolvedValue(undefined);
  const hide = vi.fn().mockResolvedValue(undefined);
  const layout = new NativePageLayout(() => surface, () => true, send, hide, () => 0, overlays);
  disposers.push(() => {
    layout.destroy(); host.remove(); overlays.remove();
    if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
    else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  });
  const next = async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); await Promise.resolve(); };
  return { surface, overlays, send, hide, next, layout };
}

it('keeps the page scrollable beneath a passive tooltip while blocking interactive overlays', async () => {
  const f = setup();
  const pane = document.createElement('div'); pane.className = 'cdk-overlay-pane';
  const tooltip = document.createElement('ex-tooltip'); tooltip.setAttribute('role', 'tooltip'); tooltip.textContent = 'Browser controls';
  pane.append(tooltip); f.overlays.append(pane);
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 200, 24));
  await f.next();
  expect(f.send.mock.lastCall?.[0]).toMatchObject({ visible: true, inputReady: true });
  // A tooltip inside another interactive pane must not exempt that pane.
  pane.append(document.createElement('button'));
  await f.next();
  expect(f.send.mock.lastCall?.[0].inputReady).toBe(false);
  pane.remove();
  await f.next();
  expect(f.send.mock.lastCall?.[0].inputReady).toBe(true);
  const menu = document.createElement('div'); menu.setAttribute('role', 'menu');
  f.overlays.append(menu);
  await f.next();
  expect(f.send.mock.lastCall?.[0].inputReady).toBe(false);
  menu.remove();
  await f.next();
  expect(f.send.mock.lastCall?.[0].inputReady).toBe(true);
});

it('retains modal and hidden-surface input gates and releases its heartbeat on disposal', async () => {
  const f = setup();
  await f.next();
  f.surface.setAttribute('inert', '');
  await f.next();
  expect(f.send.mock.lastCall?.[0]).toMatchObject({ visible: true, inputReady: false });
  f.surface.removeAttribute('inert'); f.surface.setAttribute('hidden', '');
  await f.next();
  expect(f.send.mock.lastCall?.[0]).toMatchObject({ visible: false, inputReady: false });
  f.layout.destroy();
  const count = f.send.mock.calls.length;
  await f.next();
  expect(f.send).toHaveBeenCalledTimes(count);
  expect(f.hide).toHaveBeenCalledOnce();
});
