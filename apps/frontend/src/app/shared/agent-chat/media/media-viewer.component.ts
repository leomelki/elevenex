import { A11yModule } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronLeft,
  lucideChevronRight,
  lucideMaximize,
  lucideMinus,
  lucidePlus,
  lucideX,
  lucideImage,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import { Z_MODAL_DATA, ZardDialogRef } from '@/shared/components/dialog';

export interface MediaImage {
  src: string;
  label: string;
}
export interface MediaViewerData {
  images: MediaImage[];
  index: number;
}

@Component({
  selector: 'agent-media-viewer',
  imports: [A11yModule, ZardButtonComponent, NgIcon],
  viewProviders: [
    provideIcons({
      lucideChevronLeft,
      lucideChevronRight,
      lucideMaximize,
      lucideMinus,
      lucidePlus,
      lucideX,
      lucideImage,
    }),
  ],
  templateUrl: './media-viewer.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0 w-full', '(document:keydown)': 'onKey($event)' },
})
export class MediaViewerComponent {
  readonly data = inject<MediaViewerData>(Z_MODAL_DATA);
  readonly dialog = inject(ZardDialogRef);
  readonly index = signal(this.data.index);
  readonly image = computed(() => this.data.images[this.index()]);
  readonly zoom = signal(0);
  readonly loading = signal(true);
  readonly failed = signal(false);
  readonly dimensions = signal('');
  readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport');
  readonly naturalSize = signal({ width: 0, height: 0 });
  readonly viewportSize = signal({ width: 0, height: 0 });
  readonly pan = signal({ x: 0, y: 0 });
  readonly fitScale = computed(() => {
    const image = this.naturalSize();
    const viewport = this.viewportSize();
    if (!image.width || !image.height || !viewport.width || !viewport.height) return 1;
    return Math.min(1, viewport.width / image.width, viewport.height / image.height);
  });
  readonly scale = computed(() => this.zoom() || this.fitScale());
  readonly zoomLabel = computed(() =>
    this.zoom() === 0 ? 'Fit' : `${Math.round(this.zoom() * 100)}%`,
  );
  readonly imageTransform = computed(
    () =>
      `translate(-50%, -50%) translate(${this.pan().x}px, ${this.pan().y}px) scale(${this.scale()})`,
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const viewport = this.viewport().nativeElement;
      const measure = () => {
        this.viewportSize.set({
          width: Math.max(0, viewport.clientWidth - 32),
          height: Math.max(0, viewport.clientHeight - 32),
        });
        this.pan.set(this.clampPan(this.pan()));
      };
      measure();
      const wheel = (event: WheelEvent) => this.onWheel(event);
      // Pinch arrives as Ctrl+wheel in Chromium. Prevent browser/page zoom only
      // inside the image viewport; toolbar and the rest of the app stay native.
      viewport.addEventListener('wheel', wheel, { passive: false });
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      destroyRef.onDestroy(() => {
        viewport.removeEventListener('wheel', wheel);
        observer.disconnect();
      });
    });
  }

  fit(): void {
    this.zoom.set(0);
    this.pan.set({ x: 0, y: 0 });
  }

  changeZoom(direction: number): void {
    if (this.loading() || this.failed()) return;
    const current = this.zoom();
    const next = direction > 0 ? Math.floor(current + 1.001) : Math.ceil(current - 1.001);
    if (next <= 0 || (direction < 0 && next < this.fitScale())) this.fit();
    else this.setZoom(Math.min(3, next));
  }

  private setZoom(next: number, anchor = { x: 0, y: 0 }): void {
    const previous = this.scale();
    const scale = Math.min(3, Math.max(this.fitScale(), next));
    const ratio = scale / previous;
    const pan = this.pan();
    this.zoom.set(scale);
    this.pan.set(
      this.clampPan({
        x: anchor.x + (pan.x - anchor.x) * ratio,
        y: anchor.y + (pan.y - anchor.y) * ratio,
      }),
    );
  }

  private clampPan(pan: { x: number; y: number }): { x: number; y: number } {
    const image = this.naturalSize();
    const viewport = this.viewportSize();
    const maxX = Math.max(0, (image.width * this.scale() - viewport.width) / 2);
    const maxY = Math.max(0, (image.height * this.scale() - viewport.height) / 2);
    return {
      x: maxX ? Math.max(-maxX, Math.min(maxX, pan.x)) : 0,
      y: maxY ? Math.max(-maxY, Math.min(maxY, pan.y)) : 0,
    };
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.loading() || this.failed()) return;
    const unit =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewportSize().height : 1;
    const deltaX = event.deltaX * unit;
    const deltaY = event.deltaY * unit;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    if (event.ctrlKey) {
      const rect = this.viewport().nativeElement.getBoundingClientRect();
      const next = this.scale() * Math.exp(-Math.max(-100, Math.min(100, deltaY)) * 0.01);
      if (next <= this.fitScale()) this.fit();
      else
        this.setZoom(next, {
          x: event.clientX - rect.left - rect.width / 2,
          y: event.clientY - rect.top - rect.height / 2,
        });
    } else {
      const pan = this.pan();
      // Match native two-finger scrolling in both axes, including inertia.
      this.pan.set(this.clampPan({ x: pan.x - deltaX, y: pan.y - deltaY }));
    }
  }

  move(delta: number): void {
    const index = this.index() + delta;
    if (index < 0 || index >= this.data.images.length) return;
    this.loading.set(true);
    this.failed.set(false);
    this.fit();
    this.naturalSize.set({ width: 0, height: 0 });
    this.dimensions.set('');
    this.index.set(index);
  }

  loaded(event: Event): void {
    const img = event.target as HTMLImageElement;
    this.naturalSize.set({ width: img.naturalWidth, height: img.naturalHeight });
    this.loading.set(false);
    this.dimensions.set(`${img.naturalWidth} × ${img.naturalHeight}`);
  }

  onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.move(-1);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.move(1);
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      this.changeZoom(1);
    }
    if (event.key === '-') {
      event.preventDefault();
      this.changeZoom(-1);
    }
    if (event.key === '0') {
      event.preventDefault();
      this.fit();
    }
  }
}
