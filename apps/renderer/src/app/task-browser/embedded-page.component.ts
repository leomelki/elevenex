import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
} from '@angular/core';
import type { TaskBrowserSurface } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
interface TaskGuestElement extends HTMLElement {
  getWebContentsId(): number;
}
/** The nonstandard guest element and its one documented attachment handle stay confined here. */
@Component({
  selector: 'ex-embedded-page',
  template: '',
  styles: ':host { display: block; width: 100%; height: 100%; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmbeddedPageComponent {
  readonly surface = input.required<TaskBrowserSurface>();
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private guest?: TaskGuestElement;
  private cleanup?: () => void;
  constructor() {
    afterRenderEffect(() => {
      const surface = this.surface();
      if (!surface.guest) return;
      if (!this.guest) {
        // Electron supplies this element's documented API; no Electron/Node code enters Angular.
        const guest = document.createElement('webview') as TaskGuestElement;
        guest.setAttribute('partition', surface.guest.partition);
        guest.setAttribute('src', surface.guest.bootstrap);
        guest.setAttribute('aria-label', 'Task browser page');
        Object.assign(guest.style, {
          display: 'flex',
          width: '100%',
          height: '100%',
        });
        const attach = () => {
          if (typeof guest.getWebContentsId === 'function')
            void this.bridge
              .taskBrowserAttach?.(
                surface.scopeId,
                surface.taskId,
                surface.tabId,
                guest.getWebContentsId(),
              )
              .catch(() => undefined);
        };
        guest.addEventListener('dom-ready', attach, { once: true });
        this.cleanup = () => guest.removeEventListener('dom-ready', attach);
        this.host.append(guest);
        this.guest = guest;
      }
      const stream = surface.presentation === 'stream';
      this.guest.tabIndex = stream ? -1 : 0;
      this.guest.style.opacity = stream ? '0' : '1';
      this.guest.style.pointerEvents = stream ? 'none' : 'auto';
    });
    inject(DestroyRef).onDestroy(() => {
      this.cleanup?.();
      this.guest?.remove();
      this.guest = undefined;
    });
  }
}
