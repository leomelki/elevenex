import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  viewChildren,
  signal,
} from '@angular/core';
import type { BrowserRect, TaskBrowserSurface } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { EmbeddedPageComponent } from './embedded-page.component';
import { BrowserStreamComponent } from './browser-stream.component';

/** Stable guest DOM identities: hiding/switching tasks must never reparent a webview. */
@Component({
  selector: 'ex-browser-surfaces',
  imports: [BrowserStreamComponent, EmbeddedPageComponent],
  templateUrl: './browser-surfaces.component.html',
  styleUrl: './browser-surfaces.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserSurfacesComponent {
  readonly shortcutRequested = output<'open' | 'pick' | 'controls'>();
  private readonly streams = viewChildren(BrowserStreamComponent);
  focusPage(tabId: string): void {
    this.streams()
      .find((stream) => stream.surface().tabId === tabId)
      ?.focusPage();
  }
  coordinates<T extends BrowserRect>(tabId: string, element: T): T {
    const surface = this.surfaces().find((surface) => surface.tabId === tabId),
      stream = this.streams().find(
        (stream) => stream.surface().tabId === tabId,
      );
    if (!surface || !stream?.hasFrame()) return element;
    const viewport = stream.viewport(),
      x =
        (surface.viewport?.width ?? surface.bounds.width / surface.zoom) /
        viewport.width,
      y =
        (surface.viewport?.height ?? surface.bounds.height / surface.zoom) /
        viewport.height;
    return {
      ...element,
      x: element.x * x,
      y: element.y * y,
      width: element.width * x,
      height: element.height * y,
    };
  }
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  frame(surface: TaskBrowserSurface): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    if (!surface.visible)
      return {
        x: 0,
        y: 0,
        width: surface.viewport?.width || 800,
        height: surface.viewport?.height || 600,
      };
    const parent = this.host.parentElement;
    if (!parent) return { x: 0, y: 0, width: 0, height: 0 };
    const rect = parent.getBoundingClientRect(),
      sx = rect.width / (parent.offsetWidth || 1) || 1,
      sy = rect.height / (parent.offsetHeight || 1) || 1;
    return {
      x: (surface.bounds.x / surface.zoom - rect.x) / sx,
      y: (surface.bounds.y / surface.zoom - rect.y) / sy,
      width:
        surface.viewport?.width ||
        surface.bounds.width / surface.zoom / sx ||
        800,
      height:
        surface.viewport?.height ||
        surface.bounds.height / surface.zoom / sy ||
        600,
    };
  }
  readonly interactive = input(false);
  readonly surfaces = signal<readonly TaskBrowserSurface[]>([]);
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private destroyed = false;
  private revision = 0;
  constructor() {
    const stop = this.bridge.onTaskBrowserSurfacesChanged?.((surfaces) => {
      this.revision++;
      this.surfaces.set(surfaces);
    });
    const revision = this.revision;
    void this.bridge.taskBrowserSurfaces?.().then((surfaces) => {
      if (!this.destroyed && revision === this.revision)
        this.surfaces.set(surfaces);
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      stop?.();
    });
    effect(() => {
      if (!this.interactive())
        for (const surface of this.surfaces())
          if (surface.visible)
            void this.bridge
              .taskBrowserHide(surface.scopeId, surface.taskId)
              .catch(() => undefined);
    });
  }
}
