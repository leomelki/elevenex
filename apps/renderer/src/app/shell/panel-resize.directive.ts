import { DestroyRef, Directive, ElementRef, inject, input, output } from '@angular/core';

/** Owns one captured gesture on the shell's keyboard-accessible splitter. */
@Directive({
  selector: '[exPanelResize]',
  host: {
    '(pointerdown)': 'start($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'end($event)',
    '(pointercancel)': 'interrupt($event)',
    '(lostpointercapture)': 'interrupt($event)',
    '(blur)': 'stop(true)',
    '(window:blur)': 'stop(true)',
    '(keydown)': 'key($event)',
    '(dblclick)': 'widthChanged.emit(null)',
  },
})
export class PanelResizeDirective {
  readonly panel = input.required<HTMLElement>({ alias: 'exPanelResize' });
  readonly width = input.required<number>();
  readonly minimum = input.required<number>();
  readonly maximum = input.required<number>();
  readonly widthChanged = output<number | null>();
  readonly resizeStarted = output<void>();
  readonly resizeEnded = output<boolean>();
  private readonly handle = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private drag?: { id: number; x: number; width: number; scale: number; moved: boolean };

  constructor() {
    inject(DestroyRef).onDestroy(() => this.release());
  }

  protected start(event: PointerEvent): void {
    if (this.drag || !event.isPrimary || event.button !== 0) return;
    const panel = this.panel();
    const width = panel.offsetWidth;
    if (!width) return;
    this.handle.setPointerCapture(event.pointerId);
    this.drag = { id: event.pointerId, x: event.clientX, width, scale: panel.getBoundingClientRect().width / width || 1, moved: false };
    event.preventDefault();
    this.handle.focus({ preventScroll: true });
    this.resizeStarted.emit();
  }

  protected move(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved && event.clientX === drag.x) return;
    drag.moved = true;
    const width = Math.round(drag.width + (drag.x - event.clientX) / drag.scale);
    this.widthChanged.emit(width);
  }

  protected end(event: PointerEvent): void {
    if (event.pointerId !== this.drag?.id) return;
    this.move(event);
    this.stop(false);
  }

  protected interrupt(event: PointerEvent): void {
    if (event.pointerId === this.drag?.id) this.stop(true);
  }

  protected stop(cancelled: boolean): void {
    if (!this.drag) return;
    this.release();
    this.resizeEnded.emit(cancelled);
  }

  protected key(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.drag) {
      event.preventDefault();
      event.stopPropagation();
      this.stop(true);
      return;
    }
    if (this.drag || event.altKey || event.metaKey || event.ctrlKey) return;
    const step = event.shiftKey ? 64 : 16;
    const width = this.width();
    let next: number | null;
    switch (event.key) {
      case 'ArrowLeft': next = width + step; break;
      case 'ArrowRight': next = width - step; break;
      case 'Home': next = this.minimum(); break;
      case 'End': next = this.maximum(); break;
      case 'Enter': next = null; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.widthChanged.emit(next);
  }

  private release(): void {
    const drag = this.drag;
    this.drag = undefined;
    if (drag && this.handle.hasPointerCapture(drag.id)) this.handle.releasePointerCapture(drag.id);
  }
}
