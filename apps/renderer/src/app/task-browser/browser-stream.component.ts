import { browserFrameSize } from './browser-frame';
import { BrowserVideoDecoder } from './browser-video';
import { BrowserInputLane } from './browser-input-lane';
import { BrowserHumanInput } from './browser-human-input';
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
  private readonly videoDecoder = new BrowserVideoDecoder();
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
  readonly humanInput = new BrowserHumanInput(
    input => this.inputLane.send(input),
    () => this.inputElement()?.nativeElement,
    event => this.point(event),
    () => this.viewport().height,
    intent => { this.inputLane.cancel(); this.shortcutRequested.emit(intent); },
  );
  private surfaceIdentity = '';
  private displayRevision = 0;
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
        (!frame.video && !browserFrameSize(frame.jpeg)) ||
        (frame.video && (!(frame.video.data instanceof Uint8Array) || frame.video.data.byteLength > 3_000_000 ||
          typeof frame.video.key !== 'boolean' || !Number.isSafeInteger(frame.video.timestamp) || frame.video.timestamp < 0 ||
          !/^[a-f0-9-]{36}$/.test(frame.video.epoch))) ||
        frame.width < 1 ||
        frame.height < 1 ||
        frame.width > 16384 ||
        frame.height > 16384
      )
        return;
      if (frame.streamId !== this.stream) {
        this.videoDecoder.reset();
        this.stream = frame.streamId;
        this.sequence = 0;
      }
      if (frame.sequence <= this.sequence) return;
      this.latest = frame;
      void this.paint();
    });
    effect(() => {
      const surface = this.surface();
      const identity = JSON.stringify([surface.scopeId, surface.taskId, surface.tabId]);
      if (identity !== this.surfaceIdentity || !surface.visible) {
        this.displayRevision++;
        this.surfaceIdentity = identity;
        this.latest = undefined;
        this.videoDecoder.reset();
        this.stream = '';
        this.sequence = 0;
        this.hasFrame.set(false);
        this.status.set(surface.visible ? 'Connecting page display…' : 'Page display paused.');
        const canvas = this.canvas()?.nativeElement;
        if (canvas && (canvas.width !== 1 || canvas.height !== 1)) { canvas.width = 1; canvas.height = 1; }
        this.inputLane.cancel();
        this.humanInput.clear();
      }
      this.updateAuthority();
    });
    const blur = () => this.humanInput.releaseInput();
    window.addEventListener('blur', blur);
    inject(DestroyRef).onDestroy(() => {
      this.humanInput.destroy();
      this.disposed = true;
      window.removeEventListener('blur', blur);
      stop?.();
      this.latest = undefined;
      this.videoDecoder.destroy();
      this.inputLane.destroy();
    });
  }
  private async paint(): Promise<void> {
    if (this.decoding || !this.latest) return;
    this.decoding = true;
    const frame = this.latest;
    const revision = this.displayRevision;
    const surface = this.surface();
    this.latest = undefined;
    let bitmap: ImageBitmap | VideoFrame | undefined;
    let decoded = false;
    try {
      bitmap = frame.video ? await this.videoDecoder.decode(frame.video) : await createImageBitmap(
        new Blob([frame.jpeg.slice().buffer], { type: 'image/jpeg' }),
      );
      const canvas = this.canvas()?.nativeElement;
      if (
        this.disposed ||
        !canvas ||
        revision !== this.displayRevision ||
        !this.surface().visible ||
        frame.streamId !== this.stream ||
        frame.sequence <= this.sequence
      )
        return;
      const width = 'displayWidth' in bitmap ? bitmap.displayWidth : bitmap.width;
      const height = 'displayHeight' in bitmap ? bitmap.displayHeight : bitmap.height;
      if (
        width > 4096 || height > 4096 || width * height > 8_000_000
      )
        throw new Error('Frame too large');
      // Reallocating the backing store on every frame clears it and forces GPU work.
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Page display unavailable');
      context.drawImage(bitmap, 0, 0);
      if (
        this.viewport().width !== frame.width ||
        this.viewport().height !== frame.height
      )
        this.viewport.set({ width: frame.width, height: frame.height });
      this.hasFrame.set(true);
      this.sequence = frame.sequence;
      decoded = true;
      this.status.set(this.inputLane.needsInteraction ? 'Input interrupted. Click the page or Focus page to resume.' : '');
      this.updateAuthority();
    } catch {
      if (!this.disposed && revision === this.displayRevision)
        this.status.set(
          'Page display interrupted. Reload the page to reconnect.',
        );
    } finally {
      bitmap?.close();
      this.decoding = false;
      if (!this.disposed) {
        void this.bridge
          .taskBrowserFrameAck?.(
            surface.scopeId,
            surface.taskId,
            surface.tabId,
            frame.streamId,
            frame.sequence,
            ...(frame.video ? [decoded] : []),
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
    if (!rect.width || !rect.height) return null;
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
  focusPage(): void {
    this.inputLane.resume(); if (this.hasFrame()) this.status.set('');
    this.inputElement()?.nativeElement.focus({ preventScroll: true });
  }
}
