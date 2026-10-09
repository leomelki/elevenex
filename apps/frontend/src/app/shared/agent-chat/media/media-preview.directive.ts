import { freshLocalMediaUrl } from './local-media-url';
import { DestroyRef, Directive, ElementRef, inject } from '@angular/core';
import { ZardDialogService } from '@/shared/components/dialog';
import { MediaViewerComponent } from './media-viewer.component';

/** Delegate image activation so streamed Markdown needs no per-image listeners. */
@Directive({
  selector: '[mediaPreview]',
  host: { '(click)': 'open($event)', '(keydown)': 'onKey($event)' },
})
export class MediaPreviewDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogs = inject(ZardDialogService);

  onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') this.open(event);
  }

  open(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    const image = target?.closest<HTMLImageElement>('img');
    const host = this.host.nativeElement;
    if (!image || !host.contains(image)) return;
    event.preventDefault();
    event.stopPropagation();
    const images =
      host instanceof HTMLImageElement
        ? [host]
        : Array.from(host.querySelectorAll<HTMLImageElement>('img'));
    const revision = crypto.randomUUID();
    const ref = this.dialogs.create({
      zContent: MediaViewerComponent,
      zData: {
        images: images.map((img, index) => ({
          src: freshLocalMediaUrl(img.currentSrc || img.src, `${revision}-${index}`),
          label: img.alt || 'Image preview',
        })),
        index: images.indexOf(image),
      },
      zAriaLabel: 'Image preview',
      zHideFooter: true,
      zClosable: false,
      zWidth: 'min(1200px, calc(100vw - 2rem))',
      zCustomClasses:
        'max-w-none sm:max-w-none p-0 gap-0 overflow-hidden rounded-xl [&>main]:min-w-0',
    });
    const unregister = this.destroyRef.onDestroy(() => ref.close());
    ref.afterClosed().subscribe(() => {
      unregister();
      if (image.isConnected) image.focus({ preventScroll: true });
    });
  }
}
