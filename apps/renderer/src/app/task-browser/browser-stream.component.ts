import { BrowserPointerLock } from './browser-pointer-lock';
import { ButtonComponent } from '../ui';
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
  TaskBrowserStreamEvent,
  TaskBrowserStreamInput,
  TaskBrowserSurface,
} from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';

/** Presentation and human input only. No pixels or input text enter agent observation. */
@Component({
  selector: 'ex-browser-stream',
  imports: [ButtonComponent],
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
  private paintedEpoch?: number;
  private pendingDisplay?: { readonly epoch: number; finish(): void };
  private readonly videoDecoder = new BrowserVideoDecoder();
  readonly viewport = signal({ width: 1, height: 1 });
  readonly hasFrame = signal(false);
  private readonly inputLane = new BrowserInputLane(
    (generation, input) => this.dispatchInput(generation, input),
    () =>
      this.status.set(
        'Control changed. Release controls, then interact again.',
      ),
    () => this.surface().inputWindow ?? 1,
    generation => this.surface().inputWindow === 4 ? this.dispatchInput(generation, { kind: 'release' }) : Promise.resolve(),
  );
  readonly pointerLock = new BrowserPointerLock(input => this.sendInput(input));
  readonly humanInput = new BrowserHumanInput(
    input => this.sendInput(input),
    () => this.inputElement()?.nativeElement,
    event => this.point(event),
    () => this.viewport().height,
    intent => { this.inputLane.cancel(); this.shortcutRequested.emit(intent); },
    () => this.surface().keyText === true,
    () => this.surface().pointerExit === true,
    () => this.pointerLock.locked(),
  );
  private surfaceIdentity = '';
  private pointerSurface?: TaskBrowserSurface;
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
          (frame.video.present !== undefined && typeof frame.video.present !== 'boolean') ||
          !/^[a-f0-9-]{36}$/.test(frame.video.epoch))) ||
        frame.width < 1 ||
        frame.height < 1 ||
        frame.width > 16384 ||
        frame.height > 16384
        || (frame.displayEpoch !== undefined && (!Number.isSafeInteger(frame.displayEpoch) || frame.displayEpoch < 1))
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
      if (!surface.visible || !surface.interactive || !surface.pointerLocked ||
          !this.pointerSurface || this.pointerIdentity(surface) !== this.pointerIdentity(this.pointerSurface))
        this.pointerLock.release(identity === this.surfaceIdentity);
      if (this.pendingDisplay && (!surface.visible || identity !== this.surfaceIdentity || (surface.displayEpoch ?? 0) >= this.pendingDisplay.epoch))
        this.pendingDisplay.finish();
      if (identity !== this.surfaceIdentity || !surface.visible) {
        if (identity !== this.surfaceIdentity) this.inputLane.reset();
        this.displayRevision++;
        this.surfaceIdentity = identity;
        this.latest = undefined;
        this.videoDecoder.reset();
        this.stream = '';
        this.sequence = 0;
        this.paintedEpoch = undefined;
        this.hasFrame.set(false);
        this.status.set(surface.visible ? 'Connecting page display…' : 'Page display paused.');
        const canvas = this.canvas()?.nativeElement;
        if (canvas && (canvas.width !== 1 || canvas.height !== 1)) { canvas.width = 1; canvas.height = 1; }
        this.inputLane.cancel();
        this.humanInput.clear();
      }
      this.updateAuthority();
    });
    const blur = () => { this.pointerLock.release(); this.humanInput.releaseInput(); };
    window.addEventListener('blur', blur);
    inject(DestroyRef).onDestroy(() => {
      this.pointerLock.destroy();
      this.humanInput.destroy();
      this.disposed = true;
      this.pendingDisplay?.finish();
      window.removeEventListener('blur', blur);
      stop?.();
      this.latest = undefined;
      this.videoDecoder.destroy();
      this.inputLane.destroy();
    });
  }
  startPointerLock(): void {
    const canvas = this.canvas()?.nativeElement;
    if (!canvas || !this.surface().interactive || !this.surface().pointerLocked) return;
    this.pointerSurface = this.surface();
    this.inputLane.resume();
    this.inputElement()?.nativeElement.focus({ preventScroll: true });
    void this.pointerLock.start(canvas, this.surface().pointerLockEpoch);
  }
  private pointerIdentity(surface: TaskBrowserSurface): string {
    return JSON.stringify([surface.scopeId, surface.taskId, surface.tabId, surface.generation, surface.displayEpoch, surface.pointerLockEpoch]);
  }
  private sendInput(input: TaskBrowserStreamEvent): void {
    if (input.kind === 'pointer-relative' || input.kind === 'pointer-unlock') {
      const owner = this.pointerSurface, current = this.surface();
      if (!owner || owner.scopeId !== current.scopeId || owner.taskId !== current.taskId || owner.tabId !== current.tabId) return;
      if (input.kind === 'pointer-relative' && this.pointerLock.epoch !== undefined)
        input = { ...input, pointerLockEpoch: this.pointerLock.epoch };
    }
    this.inputLane.send(input);
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
      decoded = true;
      const expectedEpoch = this.surface().displayEpoch;
      if (frame.displayEpoch !== undefined && expectedEpoch !== undefined && frame.displayEpoch > expectedEpoch)
        await this.waitForDisplay(frame.displayEpoch);
      const canvas = this.canvas()?.nativeElement;
      if (
        this.disposed ||
        !canvas ||
        revision !== this.displayRevision ||
        !this.surface().visible ||
        frame.streamId !== this.stream ||
        frame.sequence <= this.sequence
        || frame.video?.present === false
        || (this.surface().displayEpoch !== undefined && frame.displayEpoch !== this.surface().displayEpoch)
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
      this.paintedEpoch = frame.displayEpoch;
      this.status.set(this.inputLane.needsInteraction ? 'Input interrupted. Click the page or Focus page to resume.' : '');
      this.updateAuthority();
    } catch {
      decoded = false;
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
  private waitForDisplay(epoch: number): Promise<void> {
    // Surface events reach Angular inputs on its next render. Retain this one
    // decoded frame rather than discarding a static page's only keyframe.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingDisplay === pending) this.pendingDisplay = undefined;
        reject(new Error('Page display state did not arrive'));
      }, 1000);
      const pending = { epoch, finish: () => {
        clearTimeout(timer);
        if (this.pendingDisplay === pending) this.pendingDisplay = undefined;
        resolve();
      } };
      this.pendingDisplay = pending;
    });
  }
  private dispatchInput(generation: number, input: TaskBrowserStreamInput): Promise<number> {
    const surface = this.surface();
    if (!this.bridge.taskBrowserInput) return Promise.reject(new Error('Input unavailable'));
    return this.bridge.taskBrowserInput(surface.scopeId, surface.taskId, surface.tabId, generation, input);
  }
  private updateAuthority(): void {
    const surface = this.surface(),
      viewport = this.viewport();
    const width =
        surface.viewport?.width ?? surface.bounds.width / surface.zoom,
      height = surface.viewport?.height ?? surface.bounds.height / surface.zoom;
    const matches =
      this.hasFrame() &&
      (surface.displayEpoch === undefined || surface.displayEpoch === this.paintedEpoch) &&
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
      surface.pointerLockEpoch,
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
