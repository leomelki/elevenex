import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskBrowserFrame, TaskBrowserSurface } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { BrowserStreamComponent } from './browser-stream.component';
import { BrowserVideoDecoder } from './browser-video';

const surface: TaskBrowserSurface = {
  scopeId: 'scope',
  taskId: 1,
  tabId: 'tab',
  partition: '',
  bootstrap: '',
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  viewport: { width: 800, height: 600 },
  zoom: 1,
  visible: true,
  generation: 1,
  interactive: true,
  driver: 'you',
  presentation: 'stream',
};
const frame = (sequence: number): TaskBrowserFrame => ({
  scopeId: 'scope',
  taskId: 1,
  tabId: 'tab',
  streamId: '11111111-1111-4111-8111-111111111111',
  sequence,
  width: 800,
  height: 600,
  jpeg: new Uint8Array([255, 216, 255, 192, 0, 8, 8, 2, 88, 3, 32, 1]),
});
const settle = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup() {
  const drawImage = vi.fn(),
    close = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue({ width: 800, height: 600, close }),
  );
  let deliver!: (frame: TaskBrowserFrame) => void;
  const dispatch = vi.fn().mockResolvedValue(1),
    ack = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: ELEVENEX_BRIDGE,
        useValue: {
          onTaskBrowserFrame: (listener: typeof deliver) => {
            deliver = listener;
            return vi.fn();
          },
          taskBrowserInput: dispatch,
          taskBrowserFrameAck: ack,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(BrowserStreamComponent);
  fixture.componentRef.setInput('surface', surface);
  fixture.detectChanges();
  deliver(frame(1));
  await settle();
  fixture.detectChanges();
  const textarea = fixture.nativeElement.querySelector(
    'textarea',
  ) as HTMLTextAreaElement;
  const canvas = fixture.nativeElement.querySelector(
    'canvas',
  ) as HTMLCanvasElement;
  return {
    fixture,
    textarea,
    canvas,
    deliver,
    dispatch,
    ack,
    drawImage,
    close,
  };
}

it('forwards live IME updates and commits exactly once, including canceled compositions', async () => {
  const { textarea, dispatch } = await setup();
  textarea.dispatchEvent(new CompositionEvent('compositionstart'));
  textarea.dispatchEvent(
    new CompositionEvent('compositionupdate', { data: 'に' }),
  );
  await settle();
  textarea.dispatchEvent(
    new CompositionEvent('compositionend', { data: '日本語' }),
  );
  textarea.dispatchEvent(
    new InputEvent('beforeinput', { inputType: 'insertText', data: '日本語' }),
  );
  await settle();
  expect(dispatch.mock.calls.map((call) => call[4])).toEqual([
    { kind: 'composition', text: 'に', selectionStart: 1, selectionEnd: 1 },
    { kind: 'text', text: '日本語' },
  ]);
  textarea.dispatchEvent(new CompositionEvent('compositionstart'));
  textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
  await settle();
  expect(dispatch.mock.lastCall?.[4]).toEqual({
    kind: 'composition',
    text: '',
    selectionStart: 0,
    selectionEnd: 0,
  });
});

it('uses editing intents, allows AltGr text, and releases keys on focus loss', async () => {
  const { textarea, dispatch } = await setup();
  for (const event of [
    new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true }),
    new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    }),
    new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, cancelable: true }),
  ]) {
    textarea.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await settle();
  }
  expect(dispatch.mock.calls.map((call) => call[4])).toEqual([
    { kind: 'edit', operation: 'undo' },
    { kind: 'edit', operation: 'redo' },
    { kind: 'edit', operation: 'redo' },
  ]);
  const altGr = new KeyboardEvent('keydown', {
    key: '@',
    code: 'KeyQ',
    ctrlKey: true,
    altKey: true,
    cancelable: true,
  });
  textarea.dispatchEvent(altGr);
  expect(altGr.defaultPrevented).toBe(false);
  const dead = new KeyboardEvent('keydown', { key: 'Dead', altKey: true, cancelable: true });
  textarea.dispatchEvent(dead);
  expect(dead.defaultPrevented).toBe(false);
  textarea.dispatchEvent(
    new InputEvent('beforeinput', { inputType: 'insertText', data: '@' }),
  );
  await settle();
  textarea.dispatchEvent(new Event('blur'));
  await settle();
  expect(dispatch.mock.lastCall?.[4]).toMatchObject({
    kind: 'key',
    type: 'up',
    code: 'KeyQ',
    modifiers: 0,
  });
});

it('preserves drag buttons, counts double clicks and releases canceled pointers', async () => {
  const { canvas, dispatch } = await setup();
  canvas.setPointerCapture = vi.fn();
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 800, 600),
  );
  const pointer = async (type: string, buttons: number) => {
    canvas.dispatchEvent(
      new MouseEvent(type, { clientX: 10, clientY: 20, button: 0, buttons }),
    );
    await settle();
  };
  await pointer('pointerdown', 1);
  await pointer('pointerup', 0);
  await pointer('pointerdown', 1);
  expect(dispatch.mock.lastCall?.[4]).toMatchObject({
    type: 'down',
    clicks: 2,
  });
  await pointer('pointermove', 1);
  expect(dispatch.mock.lastCall?.[4]).toMatchObject({
    type: 'move',
    button: 'left',
    buttons: 1,
  });
  canvas.dispatchEvent(new Event('pointercancel'));
  await settle();
  expect(dispatch.mock.lastCall?.[4]).toMatchObject({ type: 'up', buttons: 0 });
});

it('reuses the canvas backing store and rejects a late decode after switching tasks', async () => {
  const { fixture, canvas, deliver, ack, drawImage, close } = await setup();
  const width = vi.spyOn(canvas, 'width', 'set'),
    height = vi.spyOn(canvas, 'height', 'set');
  deliver(frame(2));
  await settle();
  expect(width).not.toHaveBeenCalled();
  expect(height).not.toHaveBeenCalled();
  let complete!: (bitmap: {
    width: number;
    height: number;
    close(): void;
  }) => void;
  vi.stubGlobal(
    'createImageBitmap',
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  deliver(frame(3));
  fixture.componentRef.setInput('surface', {
    ...surface,
    taskId: 2,
    tabId: 'other',
  });
  fixture.detectChanges();
  complete({ width: 800, height: 600, close });
  await settle();
  expect(drawImage).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(3);
  expect(ack.mock.lastCall?.slice(0, 3)).toEqual(['scope', 1, 'tab']);
  expect(fixture.componentInstance.hasFrame()).toBe(false);
});

it('keeps old pixels visible but gates input until the current document epoch is painted', async () => {
  const { fixture, textarea, dispatch, deliver, drawImage } = await setup();
  fixture.componentRef.setInput('surface', { ...surface, displayEpoch: 2 });
  fixture.detectChanges();
  const type = () => textarea.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'a' }));
  type(); await settle();
  expect(dispatch).not.toHaveBeenCalled();
  deliver({ ...frame(2), displayEpoch: 1 }); await settle();
  expect(drawImage).toHaveBeenCalledTimes(1);
  type(); await settle(); expect(dispatch).not.toHaveBeenCalled();
  deliver({ ...frame(3), displayEpoch: 2 }); await settle();
  type(); await settle();
  expect(drawImage).toHaveBeenCalledTimes(2);
  expect(dispatch.mock.lastCall?.[4]).toEqual({ kind: 'text', text: 'a' });
});

it('pairs printable keys with native text only when the host advertises support', async () => {
  const { fixture, textarea, dispatch } = await setup();
  fixture.componentRef.setInput('surface', { ...surface, keyText: true });
  fixture.detectChanges();
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'é', code: 'KeyE', altKey: true, cancelable: true }));
  textarea.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'é' }));
  textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'é', code: 'KeyE', altKey: true }));
  await settle();
  const events = dispatch.mock.calls.flatMap(call => call[4].kind === 'batch' ? call[4].events : [call[4]]);
  expect(events).toEqual([
    { kind: 'key', type: 'down', key: 'é', code: 'KeyE', keyCode: 0, modifiers: 1, text: 'é' },
    { kind: 'key', type: 'up', key: 'é', code: 'KeyE', keyCode: 0, modifiers: 1 },
  ]);
  dispatch.mockClear();
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB' }));
  textarea.dispatchEvent(new Event('blur'));
  await settle();
  expect(dispatch).not.toHaveBeenCalled();
});

it('retains a future document frame until Angular applies its matching surface state', async () => {
  const { fixture, deliver, drawImage, ack } = await setup();
  fixture.componentRef.setInput('surface', { ...surface, displayEpoch: 1 });
  fixture.detectChanges();
  deliver({ ...frame(2), displayEpoch: 2 }); await settle();
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(ack).toHaveBeenCalledTimes(1);
  fixture.componentRef.setInput('surface', { ...surface, displayEpoch: 2 });
  fixture.detectChanges(); await settle();
  expect(drawImage).toHaveBeenCalledTimes(2);
  expect(ack.mock.lastCall?.[4]).toBe(2);
});

it('keeps typing without fresh video frames or losses from unchanged surface updates', async () => {
  const { fixture, textarea, deliver, dispatch, drawImage } = await setup();
  const current = { ...surface, displayEpoch: 1, keyText: true as const, inputWindow: 4 as const };
  fixture.componentRef.setInput('surface', current);
  fixture.detectChanges();
  deliver({ ...frame(2), displayEpoch: 1 }); await settle();
  const expected = 'fast typing stays ordered even while the video is paused '.repeat(4);
  for (const character of expected) {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: character, code: 'KeyA' }));
    textarea.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: character }));
    textarea.dispatchEvent(new KeyboardEvent('keyup', { key: character, code: 'KeyA' }));
    fixture.componentRef.setInput('surface', { ...current });
    fixture.detectChanges(); await settle();
  }
  const events = dispatch.mock.calls.flatMap(call => call[4].kind === 'batch' ? call[4].events : [call[4]]);
  expect(events.flatMap(event => event.kind === 'key' && event.type === 'down' ? [event.text ?? ''] : []).join('')).toBe(expected);
  expect(events).toHaveLength(expected.length * 2);
  expect(drawImage).toHaveBeenCalledTimes(2);
});

it('decodes and acknowledges backlog packets without painting intermediate images', async () => {
  const { deliver, drawImage, ack, close } = await setup();
  // Native VideoFrame allocation is covered by the capture; this isolates the
  // decoder output's draw/close/receipt ownership without starting another codec.
  vi.spyOn(BrowserVideoDecoder.prototype, 'decode').mockResolvedValue({ displayWidth: 800, displayHeight: 600, close } as unknown as VideoFrame);
  const video = { epoch: '22222222-2222-4222-8222-222222222222', codec: 'avc1.42E02A' as const, key: true, timestamp: 1, data: new Uint8Array([1]) };
  deliver({ ...frame(2), jpeg: new Uint8Array(), video: { ...video, present: false } });
  await settle();
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(ack.mock.lastCall?.at(-1)).toBe(true);
  deliver({ ...frame(3), jpeg: new Uint8Array(), video }); await settle();
  expect(drawImage).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(3);
});
