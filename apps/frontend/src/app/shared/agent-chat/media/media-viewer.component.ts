import { A11yModule } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
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

  move(delta: number): void {
    const index = this.index() + delta;
    if (index < 0 || index >= this.data.images.length) return;
    this.loading.set(true);
    this.failed.set(false);
    this.zoom.set(0);
    this.dimensions.set('');
    this.index.set(index);
  }

  loaded(event: Event): void {
    const img = event.target as HTMLImageElement;
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
      this.zoom.update((z) => Math.min(3, z + 1));
    }
    if (event.key === '-') {
      event.preventDefault();
      this.zoom.update((z) => Math.max(0, z - 1));
    }
    if (event.key === '0') {
      event.preventDefault();
      this.zoom.set(0);
    }
  }
}
