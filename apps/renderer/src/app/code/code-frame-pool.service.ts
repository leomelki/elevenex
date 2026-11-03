import { DOCUMENT } from '@angular/common';
import { ApplicationRef, DestroyRef, EnvironmentInjector, Injectable, createComponent, inject, type ComponentRef } from '@angular/core';
import { CodeFrameComponent } from './code-frame.component';

/** Window lifetime, independent of task selection and Angular view recreation.
 * moveBefore preserves browsing contexts; appendChild would reload an iframe.
 * The locked Electron Chromium supports state-preserving DOM moves. Main owns
 * the four-workbench budget and removes frames only after upstream permits it. */
@Injectable({ providedIn: 'root' })
export class CodeFramePool {
  private readonly document = inject(DOCUMENT);
  private readonly application = inject(ApplicationRef);
  private readonly environment = inject(EnvironmentInjector);
  private readonly frames = new Map<string, ComponentRef<CodeFrameComponent>>();
  private readonly parking = this.document.createElement('div');
  constructor() {
    this.parking.hidden = true; this.parking.inert = true;
    this.document.body.append(this.parking);
    inject(DestroyRef).onDestroy(() => {
      for (const ref of this.frames.values()) this.destroy(ref);
      this.frames.clear(); this.parking.remove();
    });
  }
  mount(url: string, container: HTMLElement): () => void {
    if (!/^https:\/\/w-[a-f0-9]{32}\.[a-f0-9]{32}\.code\.elevenex\.invalid\/$/.test(url)) throw new Error('Invalid editor resource.');
    for (const [key, ref] of this.frames) if (!ref.location.nativeElement.querySelector('iframe')) { this.destroy(ref); this.frames.delete(key); }
    let ref = this.frames.get(url);
    if (!ref) {
      ref = createComponent(CodeFrameComponent, { environmentInjector: this.environment });
      ref.setInput('url', url); this.application.attachView(ref.hostView);
      // Connect before the initial frame is created. Subsequent moves stay in
      // this document and preserve the live frame, workers and unsaved buffers.
      container.append(ref.location.nativeElement); ref.changeDetectorRef.detectChanges();
      this.frames.set(url, ref);
    } else {
      container.moveBefore(ref.location.nativeElement, null);
    }
    const host: HTMLElement = ref.location.nativeElement;
    return () => { if (host.isConnected && host.parentElement === container) this.parking.moveBefore(host, null); };
  }
  private destroy(ref: ComponentRef<CodeFrameComponent>): void { this.application.detachView(ref.hostView); ref.destroy(); ref.location.nativeElement.remove(); }
}
