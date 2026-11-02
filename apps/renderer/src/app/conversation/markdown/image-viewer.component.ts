import {
  ChangeDetectionStrategy,
  Component,
  afterRenderEffect,
  computed,
  input,
  output,
  signal,
  viewChild,
  type ElementRef,
} from "@angular/core";
import { ButtonComponent, IconButtonComponent, ModalLayerComponent, TooltipDirective } from "../../ui";

/** Image-local interaction; ModalLayer owns presence, focus and dismissal. */
@Component({
  selector: "ex-image-viewer",
  imports: [ButtonComponent, IconButtonComponent, ModalLayerComponent, TooltipDirective],
  templateUrl: "./image-viewer.component.html",
  styleUrl: "./image-viewer.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageViewerComponent {
  readonly source = input.required<string>();
  readonly label = input.required<string>();
  readonly from = input.required<HTMLElement>();
  readonly open = input(true);
  readonly closeRequested = output<void>();
  readonly closed = output<void>();
  readonly viewport = viewChild<ElementRef<HTMLElement>>("viewport");
  readonly loading = signal(true);
  readonly failed = signal(false);
  readonly naturalSize = signal({ width: 0, height: 0 });
  readonly viewportSize = signal({ width: 0, height: 0 });
  readonly zoom = signal(0);
  readonly pan = signal({ x: 0, y: 0 });
  readonly dragging = signal(false);
  readonly fitScale = computed(() => {
    const image = this.naturalSize(), viewport = this.viewportSize();
    return image.width && image.height && viewport.width && viewport.height
      ? Math.min(1, viewport.width / image.width, viewport.height / image.height)
      : 1;
  });
  readonly scale = computed(() => Math.max(this.fitScale(), this.zoom()));
  readonly enlarged = computed(() => this.scale() > this.fitScale());
  readonly unavailable = computed(() => this.loading() || this.failed());
  readonly zoomLabel = computed(() => !this.enlarged() ? "Fit" : `${Math.round(this.scale() * 100)}%`);
  readonly transform = computed(() =>
    `translate(-50%, -50%) translate(${this.pan().x}px, ${this.pan().y}px) scale(${this.scale()})`,
  );
  private drag?: { id: number; x: number; y: number; pan: { x: number; y: number } };
  private dragged = false;

  constructor() {
    afterRenderEffect((cleanup) => {
      const viewport = this.viewport()?.nativeElement;
      if (!viewport) return;
      const measure = () => {
        const style = getComputedStyle(viewport);
        this.viewportSize.set({
          width: Math.max(0, viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
          height: Math.max(0, viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)),
        });
        this.pan.set(this.clampPan(this.pan()));
      };
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      const wheel = (event: WheelEvent) => this.onWheel(event);
      // Chromium delivers trackpad pinch as Ctrl+wheel. Keep page zoom native elsewhere.
      viewport.addEventListener("wheel", wheel, { passive: false });
      cleanup(() => {
        observer.disconnect();
        viewport.removeEventListener("wheel", wheel);
      });
    });
  }

  loaded(event: Event): void {
    if (!(event.target instanceof HTMLImageElement)) return;
    this.naturalSize.set({ width: event.target.naturalWidth, height: event.target.naturalHeight });
    this.loading.set(false);
  }

  fit(): void {
    this.zoom.set(0);
    this.pan.set({ x: 0, y: 0 });
  }

  changeZoom(direction: number): void {
    if (this.unavailable()) return;
    const steps = [this.fitScale(), 0.25, 0.5, 0.75, 1, 1.5, 2, 3];
    const next = direction > 0
      ? steps.find(step => step > this.scale() + 0.001) ?? 3
      : steps.filter(step => step < this.scale() - 0.001).pop() ?? this.fitScale();
    this.setZoom(next);
  }

  toggleZoom(): void {
    if (this.dragged) { this.dragged = false; return; }
    if (this.unavailable()) return;
    if (this.enlarged()) this.fit();
    else this.setZoom(this.fitScale() < 1 ? 1 : 2);
  }

  onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !this.open()) return;
    if (event.key === "+" || event.key === "=") this.changeZoom(1);
    else if (event.key === "-") this.changeZoom(-1);
    else if (event.key === "0") this.fit();
    else if (this.enlarged() && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const pan = this.pan();
      this.pan.set(this.clampPan({
        x: pan.x + (event.key === "ArrowLeft" ? 48 : event.key === "ArrowRight" ? -48 : 0),
        y: pan.y + (event.key === "ArrowUp" ? 48 : event.key === "ArrowDown" ? -48 : 0),
      }));
    }
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  pointerDown(event: PointerEvent): void {
    this.dragged = false;
    if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
    // Pointer capture must leave keyboard shortcuts inside the modal after a drag.
    event.currentTarget.focus({ preventScroll: true });
    if (!this.enlarged()) return;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: this.pan() };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  pointerMove(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.id) return;
    const x = event.clientX - this.drag.x, y = event.clientY - this.drag.y;
    if (Math.hypot(x, y) > 4) this.dragged = true;
    if (!this.dragged) return;
    this.dragging.set(true);
    this.pan.set(this.clampPan({ x: this.drag.pan.x + x, y: this.drag.pan.y + y }));
  }

  pointerEnd(event: PointerEvent): void {
    if (event.pointerId !== this.drag?.id) return;
    this.drag = undefined;
    this.dragging.set(false);
  }

  private setZoom(next: number, anchor = { x: 0, y: 0 }): void {
    if (next <= this.fitScale()) { this.fit(); return; }
    const previous = this.scale(), pan = this.pan();
    this.zoom.set(Math.min(3, next));
    const ratio = this.scale() / previous;
    this.pan.set(this.clampPan({
      x: anchor.x + (pan.x - anchor.x) * ratio,
      y: anchor.y + (pan.y - anchor.y) * ratio,
    }));
  }

  private clampPan(pan: { x: number; y: number }): { x: number; y: number } {
    const image = this.naturalSize(), viewport = this.viewportSize();
    const maxX = Math.max(0, (image.width * this.scale() - viewport.width) / 2);
    const maxY = Math.max(0, (image.height * this.scale() - viewport.height) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, pan.x)), y: Math.max(-maxY, Math.min(maxY, pan.y)) };
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (this.unavailable() || !this.open()) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewportSize().height : 1;
    const x = event.deltaX * unit, y = event.deltaY * unit;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (event.ctrlKey) {
      const rect = this.viewport()?.nativeElement.getBoundingClientRect();
      if (!rect) return;
      this.setZoom(this.scale() * Math.exp(-Math.max(-100, Math.min(100, y)) * 0.01), {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      });
    } else {
      const pan = this.pan();
      this.pan.set(this.clampPan({ x: pan.x - x, y: pan.y - y }));
    }
  }
}
