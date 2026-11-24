import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, inject, input, signal, viewChild } from '@angular/core';
import { APP_INPUT_GUIDANCE, APP_VIDEO_MAX_AXIS, APP_VIDEO_MAX_BYTES, APP_VIDEO_MAX_PIXELS, type TaskAppFrame } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { H264Decoder } from '../media/h264-decoder';
import { ButtonComponent } from '../ui';
import { AppInputQueue, appPoint } from './app-input';

/** One mounted surface owns one viewer lease. The enclosing run view keys it by task and run. */
@Component({
  selector: 'ex-app-stream', imports: [ButtonComponent],
  templateUrl: './app-stream.component.html', styleUrl: './app-stream.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppStreamComponent {
  readonly scopeId = input.required<string>();
  readonly taskId = input.required<number>();
  readonly runId = input.required<string>();
  readonly name = input.required<string>();
  readonly actual = input(false);
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly keyboard = viewChild.required<ElementRef<HTMLTextAreaElement>>('keyboard');
  private readonly focusButton = viewChild<unknown, ElementRef<HTMLButtonElement>>('focusButton', { read: ElementRef });
  readonly state = signal<'connecting' | 'live' | 'interrupted'>('connecting');
  readonly error = signal('');
  readonly controlling = signal(false);
  private width = 0;
  private height = 0;
  private watchId?: string;
  private sequence = 0;
  private disposed = false;
  private queue: TaskAppFrame[] = [];
  private queuedBytes = 0;
  private painting = false;
  private lastComposition?: string;
  private compositionTimer?: ReturnType<typeof setTimeout>;
  private readonly decoder = new H264Decoder({ width: APP_VIDEO_MAX_AXIS, height: APP_VIDEO_MAX_AXIS, pixels: APP_VIDEO_MAX_PIXELS });
  private readonly lane = new AppInputQueue(async event => {
    if (this.watchId && this.controlling()) await this.bridge.taskAppInput?.(this.scopeId(), this.watchId, event);
  }, reason => {
    this.release();
    const detail = reason instanceof Error ? reason.message : '';
    this.error.set(Object.values(APP_INPUT_GUIDANCE).find(message => detail.endsWith(message)) ?? 'Input interrupted. Focus the app to resume.');
  });
  private composing = false;
  private readonly keys = new Set<string>();
  private pressedPointer?: number;

  constructor() {
    const frames = this.bridge.onTaskAppFrame?.(frame => this.receive(frame));
    const closed = this.bridge.onTaskAppClosed?.(event => {
      if (this.watchId !== event.watchId || this.scopeId() !== event.scopeId) return;
      this.interrupt(event.reason);
      if (event.reason === 'App window changed. Reopen the stream.') void this.start();
    });
    const visibility = () => {
      if (document.hidden) this.disconnect();
      else void this.start();
    };
    const blur = () => this.release();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', blur);
    afterNextRender(() => void this.start());
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      frames?.(); closed?.();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', blur);
      this.disconnect();
    });
  }

  async start(): Promise<void> {
    if (this.disposed || document.hidden || this.watchId) return;
    const id = crypto.randomUUID();
    this.watchId = id;
    this.sequence = 0;
    this.state.set('connecting');
    this.error.set('');
    try {
      const result = await this.bridge.taskAppWatch?.(this.scopeId(), this.taskId(), this.runId(), id);
      if (this.watchId === id && !result?.ok) this.interrupt(result?.error.message ?? 'Streaming is unavailable on this machine.');
    } catch { if (this.watchId === id) this.interrupt('The display could not connect.'); }
  }

  private receive(frame: TaskAppFrame): void {
    if (this.disposed || frame.watchId !== this.watchId || frame.scopeId !== this.scopeId() ||
      frame.taskId !== this.taskId() || frame.runId !== this.runId()) return;
    if (frame.sequence !== this.sequence + 1) { this.interrupt('The video stream lost a frame.'); return; }
    if (this.queue.length >= 8 || this.queuedBytes + frame.data.byteLength > APP_VIDEO_MAX_BYTES) {
      this.interrupt('The display could not keep up with the stream.'); return;
    }
    this.sequence = frame.sequence;
    this.queue.push(frame);
    this.queuedBytes += frame.data.byteLength;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.painting) return;
    this.painting = true;
    try {
      while (this.queue.length) {
        const frame = this.queue.shift()!;
        this.queuedBytes -= frame.data.byteLength;
        await this.paint(frame);
      }
    } finally { this.painting = false; }
  }

  private async paint(frame: TaskAppFrame): Promise<void> {
    let bitmap: VideoFrame | undefined;
    try {
      bitmap = await this.decoder.decode({ ...frame, epoch: frame.watchId });
      if (frame.watchId !== this.watchId) return;
      if (bitmap.displayWidth !== frame.width || bitmap.displayHeight !== frame.height) throw new Error('Invalid display dimensions');
      const canvas = this.canvas()!.nativeElement;
      if (canvas.width !== bitmap.displayWidth) canvas.width = bitmap.displayWidth;
      if (canvas.height !== bitmap.displayHeight) canvas.height = bitmap.displayHeight;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Canvas unavailable');
      context.drawImage(bitmap, 0, 0);
      this.width = frame.width;
      this.height = frame.height;
      this.state.set('live');
      await this.bridge.taskAppFrameAck?.(frame.scopeId, frame.watchId, frame.sequence);
    } catch { if (frame.watchId === this.watchId) this.interrupt('The app display was interrupted.'); }
    finally { bitmap?.close(); }
  }

  private interrupt(message: string): void { this.disconnect(); this.error.set(message); this.state.set('interrupted'); }

  private disconnect(): void {
    this.release();
    const id = this.watchId;
    this.watchId = undefined;
    this.queue = []; this.queuedBytes = 0;
    this.width = this.height = 0;
    this.decoder.reset();
    const canvas = this.canvas()?.nativeElement;
    if (canvas) canvas.width = canvas.height = 1;
    this.state.set('connecting');
    if (id) void this.bridge.taskAppUnwatch?.(this.scopeId(), id).catch(() => {});
  }

  focus(): void {
    if (this.state() !== 'live') return;
    this.error.set('');
    this.keyboard().nativeElement.focus({ preventScroll: true });
    this.controlling.set(true);
  }

  release(restore = false): void {
    this.lane.cancel();
    this.composing = false;
    clearTimeout(this.compositionTimer); this.lastComposition = undefined;
    this.keys.clear();
    this.pressedPointer = undefined;
    const controlled = this.controlling();
    this.controlling.set(false);
    if (controlled && this.watchId) void this.bridge.taskAppReleaseInput?.(this.scopeId(), this.watchId).catch(() => {});
    if (restore) this.focusButton()?.nativeElement.focus({ preventScroll: true });
  }

  pointer(event: PointerEvent, kind: 'move' | 'down' | 'up'): void {
    if (this.state() !== 'live' || !event.isPrimary || event.button > 2) return;
    const canvas = this.canvas()!.nativeElement;
    const point = appPoint(event, canvas, this.width, this.height);
    if (!point) return;
    if (kind === 'down') {
      this.focus();
      this.pressedPointer = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
    }
    if (!this.controlling()) return;
    event.preventDefault();
    if (kind === 'up' && !event.buttons) this.pressedPointer = undefined;
    const button = event.button === 2 ? 2 : event.button === 1 ? 1 : 0;
    this.lane.push({ kind, ...point, ...(kind === 'move' ? {} : { button }) });
  }

  pointerLost(): void { if (this.pressedPointer !== undefined) this.release(true); }

  wheel(event: WheelEvent): void {
    if (!this.controlling()) return;
    const point = appPoint(event, this.canvas()!.nativeElement, this.width, this.height);
    if (!point) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1;
    const delta = (n: number) => Math.max(-4096, Math.min(4096, Math.round(n * scale)));
    this.lane.push({ kind: 'wheel', ...point, deltaX: delta(event.deltaX), deltaY: delta(event.deltaY) });
  }

  key(event: KeyboardEvent, down: boolean): void {
    if (!this.controlling()) return;
    event.stopPropagation();
    if (event.shiftKey && event.key === 'Escape') {
      event.preventDefault();
      if (down) this.release(true);
      return;
    }
    if (event.isComposing || this.composing || event.key === 'Process' || event.key === 'Dead' || event.keyCode === 229) return;
    // Native text input handles the viewer's keyboard layout, dead keys and IME.
    // Forward physical keys only for navigation, modifiers, and shortcuts.
    const text = event.key.length === 1 && !event.metaKey && (!event.ctrlKey || event.getModifierState('AltGraph'));
    if ((down && text) || (!down && !this.keys.has(event.code))) return;
    if (!event.code) return;
    event.preventDefault();
    if (down) this.keys.add(event.code); else this.keys.delete(event.code);
    this.lane.push({ kind: 'key', code: event.code, down });
  }

  compositionStart(): void { this.composing = true; }
  compositionEnd(event: CompositionEvent): void {
    this.composing = false;
    if (this.controlling() && event.data) {
      this.sendText(event.data);
      this.lastComposition = event.data;
      clearTimeout(this.compositionTimer);
      this.compositionTimer = setTimeout(() => { this.lastComposition = undefined; }, 0);
    }
    this.keyboard().nativeElement.value = '';
  }
  beforeInput(event: Event): void {
    const input = event as InputEvent;
    if (!this.controlling() || this.composing || input.isComposing) return;
    input.preventDefault();
    if (input.inputType === 'insertText' && input.data && input.data !== this.lastComposition) this.sendText(input.data);
  }
  private sendText(text: string): void {
    if (text.length > 4096) { this.error.set('Text is too long to send.'); return; }
    let chunk = '';
    for (const character of text) {
      if (chunk.length + character.length > 256) { this.lane.push({ kind: 'text', text: chunk }); chunk = ''; }
      chunk += character;
    }
    if (chunk) this.lane.push({ kind: 'text', text: chunk });
  }
}
