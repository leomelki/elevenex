import { browserFrameSize } from './browser-frame';
import { BrowserInputLane } from './browser-input-lane';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type {
  TaskBrowserFrame,
  TaskBrowserStreamEvent,
  TaskBrowserSurface,
} from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';

/** Presentation and human input only. No pixels or input text enter agent observation. */
@Component({
  selector: 'ex-browser-stream',
  templateUrl: './browser-stream.component.html',
  styleUrl: './browser-stream.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserStreamComponent {
  readonly shortcutRequested = output<'open' | 'pick' | 'controls'>();
  readonly surface = input.required<TaskBrowserSurface>();
  readonly status = signal('Connecting page display…');
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly inputElement =
    viewChild<ElementRef<HTMLTextAreaElement>>('inputElement');
  private disposed = false;
  private decoding = false;
  private latest?: TaskBrowserFrame;
  private stream = '';
  private sequence = 0;
  readonly viewport = signal({ width: 1, height: 1 });
  readonly hasFrame = signal(false);
  private readonly inputLane = new BrowserInputLane(
    async (generation, input) => {
      const surface = this.surface();
      if (!this.bridge.taskBrowserInput) throw new Error('Input unavailable');
      return this.bridge.taskBrowserInput(
        surface.scopeId,
        surface.taskId,
        surface.tabId,
        generation,
        input,
      );
    },
    () =>
      this.status.set(
        'Control changed. Release controls, then interact again.',
      ),
  );
  private composing = false;
  constructor() {
    const stop = this.bridge.onTaskBrowserFrame?.((frame) => {
      const surface = this.surface();
      if (
        this.disposed ||
        frame.scopeId !== surface.scopeId ||
        frame.taskId !== surface.taskId ||
        frame.tabId !== surface.tabId ||
        !surface.visible
      )
        return;
      if (
        !(frame.jpeg instanceof Uint8Array) ||
        frame.jpeg.byteLength > 3_000_000 ||
        !Number.isFinite(frame.width) ||
        !Number.isFinite(frame.height) ||
        !Number.isSafeInteger(frame.sequence) ||
        frame.sequence < 1 ||
        typeof frame.streamId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(frame.streamId) ||
        !browserFrameSize(frame.jpeg) ||
        frame.width < 1 ||
        frame.height < 1 ||
        frame.width > 16384 ||
        frame.height > 16384
      )
        return;
      if (frame.streamId !== this.stream) {
        this.stream = frame.streamId;
        this.sequence = 0;
      }
      if (frame.sequence <= this.sequence) return;
      this.latest = frame;
      void this.paint();
    });
    effect(() => {
      this.updateAuthority();
    });
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      stop?.();
      this.latest = undefined;
      this.inputLane.destroy();
    });
  }
  private async paint(): Promise<void> {
    if (this.decoding || !this.latest) return;
    this.decoding = true;
    const frame = this.latest;
    this.latest = undefined;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(
        new Blob([frame.jpeg.slice().buffer], { type: 'image/jpeg' }),
      );
      const canvas = this.canvas()?.nativeElement;
      if (
        this.disposed ||
        !canvas ||
        frame.streamId !== this.stream ||
        frame.sequence <= this.sequence
      )
        return;
      if (
        bitmap.width > 4096 ||
        bitmap.height > 4096 ||
        bitmap.width * bitmap.height > 8_000_000
      )
        throw new Error('Frame too large');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d', { alpha: false })?.drawImage(bitmap, 0, 0);
      if (
        this.viewport().width !== frame.width ||
        this.viewport().height !== frame.height
      )
        this.viewport.set({ width: frame.width, height: frame.height });
      this.hasFrame.set(true);
      this.sequence = frame.sequence;
      this.status.set(this.inputLane.needsInteraction ? 'Input interrupted. Click the page or Focus page to resume.' : '');
      this.updateAuthority();
    } catch {
      if (!this.disposed)
        this.status.set(
          'Page display interrupted. Switch display mode to reconnect.',
        );
    } finally {
      bitmap?.close();
      this.decoding = false;
      if (!this.disposed) {
        const surface = this.surface();
        void this.bridge
          .taskBrowserFrameAck?.(
            surface.scopeId,
            surface.taskId,
            surface.tabId,
            frame.streamId,
            frame.sequence,
          )
          .catch(() => undefined);
        if (this.latest) void this.paint();
      }
    }
  }
  private updateAuthority(): void {
    const surface = this.surface(),
      viewport = this.viewport();
    const width =
        surface.viewport?.width ?? surface.bounds.width / surface.zoom,
      height = surface.viewport?.height ?? surface.bounds.height / surface.zoom;
    const matches =
      this.hasFrame() &&
      Math.abs(
        viewport.width - Math.max(100, Math.min(2560, Math.round(width))),
      ) < 2 &&
      Math.abs(
        viewport.height - Math.max(100, Math.min(1600, Math.round(height))),
      ) < 2;
    this.inputLane.authority(
      surface.generation,
      surface.driver,
      surface.visible && surface.interactive && matches,
    );
  }
  private point(event: MouseEvent): { x: number; y: number } | null {
    const canvas = this.canvas()?.nativeElement;
    if (!canvas || !this.sequence) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.min(
        this.viewport().width - 0.01,
        Math.max(
          0,
          ((event.clientX - rect.left) * this.viewport().width) / rect.width,
        ),
      ),
      y: Math.min(
        this.viewport().height - 0.01,
        Math.max(
          0,
          ((event.clientY - rect.top) * this.viewport().height) / rect.height,
        ),
      ),
    };
  }
  pointer(event: PointerEvent, type: 'down' | 'up' | 'move'): void {
    event.stopPropagation();
    event.preventDefault();
    const point = this.point(event);
    if (!point) return;
    if (type === 'down') {
      this.inputElement()?.nativeElement.focus({ preventScroll: true });
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }
    this.send({
      kind: 'pointer',
      type,
      ...point,
      button:
        type === 'move'
          ? 'none'
          : event.button === 2
            ? 'right'
            : event.button === 1
              ? 'middle'
              : 'left',
      buttons: event.buttons,
      clicks: Math.min(3, Math.max(1, event.detail)),
      modifiers: this.modifiers(event),
    });
  }
  wheel(event: WheelEvent): void {
    event.stopPropagation();
    event.preventDefault();
    const point = this.point(event);
    if (!point) return;
    const scale =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? this.viewport().height
          : 1;
    this.send({
      kind: 'wheel',
      ...point,
      deltaX: Math.max(-10000, Math.min(10000, event.deltaX * scale)),
      deltaY: Math.max(-10000, Math.min(10000, event.deltaY * scale)),
      modifiers: this.modifiers(event),
    });
  }
  key(event: KeyboardEvent, type: 'down' | 'up'): void {
    event.stopPropagation();
    if (event.isComposing || this.composing) return;
    if (
      (event.shiftKey && event.key === 'Escape') ||
      ((event.metaKey || event.ctrlKey) &&
        (event.key.toLowerCase() === 't' ||
          (event.shiftKey && event.key.toLowerCase() === 'c')))
    ) {
      event.preventDefault();
      if (type === 'down') {
        this.inputLane.cancel();
        this.shortcutRequested.emit(
          event.key === 'Escape'
            ? 'controls'
            : event.key.toLowerCase() === 't'
              ? 'open'
              : 'pick',
        );
      }
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      ['c', 'v', 'x', 'a'].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      if (type === 'down')
        this.send({
          kind: 'clipboard',
          operation:
            event.key.toLowerCase() === 'c'
              ? 'copy'
              : event.key.toLowerCase() === 'v'
                ? 'paste'
                : event.key.toLowerCase() === 'x'
                  ? 'cut'
                  : 'selectAll',
        });
      return;
    }
    // Printable characters arrive through beforeinput, including composed Unicode.
    if (
      event.key.length !== 1 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      event.preventDefault();
    this.send({
      kind: 'key',
      type,
      key: event.key,
      code: event.code,
      keyCode: Math.min(255, event.keyCode),
      modifiers: this.modifiers(event),
    });
  }
  beforeInput(event: Event): void {
    event.stopPropagation();
    const input = event as InputEvent;
    if (this.composing || input.isComposing) return;
    event.preventDefault();
    if (input.inputType === 'insertText' && input.data)
      this.send({ kind: 'text', text: input.data });
  }
  compositionStart(): void {
    this.composing = true;
  }
  compositionEnd(event: CompositionEvent): void {
    this.composing = false;
    if (event.data) this.send({ kind: 'text', text: event.data });
    this.clearText();
  }
  clearText(): void {
    if (!this.composing) {
      const element = this.inputElement()?.nativeElement;
      if (element) element.value = '';
    }
  }
  focusPage(): void {
    this.inputLane.resume(); if (this.hasFrame()) this.status.set('');
    this.inputElement()?.nativeElement.focus({ preventScroll: true });
  }
  private modifiers(event: MouseEvent | KeyboardEvent): number {
    return (
      Number(event.altKey) |
      (Number(event.ctrlKey) << 1) |
      (Number(event.metaKey) << 2) |
      (Number(event.shiftKey) << 3)
    );
  }
  private send(input: TaskBrowserStreamEvent): void {
    this.inputLane.send(input);
  }
}
