import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { ButtonComponent, IconComponent } from '../src/app/ui';
import { BrowserDriver, BrowserTab, BrowserTarget, BrowserViewComponent } from '../src/app/views';

/** Example content and geometry belong to this preview, never the browser bridge. */
@Component({
  selector: 'ex-browser-demo',
  imports: [BrowserViewComponent, ButtonComponent, IconComponent],
  templateUrl: './browser-demo.component.html',
  styleUrl: './browser-demo.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserDemoComponent {
  readonly event = output<string>();
  protected readonly driver = signal<BrowserDriver>('agent');
  protected readonly width = signal<'full' | 'phone'>('full');
  protected readonly picking = signal(false);
  protected readonly active = signal('checkout');
  protected readonly tabs = signal<readonly BrowserTab[]>([
    { id: 'checkout', title: 'Checkout · Shop', url: 'localhost:3000/checkout', server: 'web', by: 'agent' },
    { id: 'docs', title: 'API docs', url: 'docs.example.com', by: 'you' },
  ]);
  protected readonly action = signal<BrowserTarget | undefined>(undefined);
  protected readonly picked = computed(() => {
    const action = this.action();
    return this.picking() && action ? { ...action, label: 'button.pay', file: 'CheckoutForm.tsx:88' } : undefined;
  });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly checkout = viewChild<ElementRef<HTMLElement>>('checkout');
  private readonly pay = viewChild<unknown, ElementRef<HTMLButtonElement>>('pay', { read: ElementRef });
  private nextTab = 0;

  constructor() {
    const destroy = inject(DestroyRef);
    let observer: ResizeObserver | undefined;
    afterRenderEffect(() => {
      const checkout = this.checkout()?.nativeElement;
      const pay = this.pay()?.nativeElement;
      if (!checkout || !pay || observer) return;
      // Re-measure when phone width or fonts change rather than hard-coding a ring.
      observer = new ResizeObserver(() => {
        const page = this.host.nativeElement.querySelector('.page');
        if (!page) return;
        const origin = page.getBoundingClientRect(), target = pay.getBoundingClientRect();
        this.action.set({ x: target.x - origin.x + page.scrollLeft, y: target.y - origin.y + page.scrollTop, w: target.width, h: target.height, label: 'Checking “Pay €24.00”' });
      });
      observer.observe(checkout);
      observer.observe(pay);
    });
    destroy.onDestroy(() => observer?.disconnect());
  }

  protected selectDriver(driver: BrowserDriver): void { this.driver.set(driver); this.picking.set(false); }
  protected addTab(): void {
    const id = `preview-${++this.nextTab}`;
    this.tabs.update(tabs => [...tabs, { id, title: 'New tab', url: 'about:blank', by: 'you' }]);
    this.active.set(id);
    this.selectDriver('you');
  }
  protected closeTab(id: string): void {
    this.tabs.update(tabs => tabs.filter(tab => tab.id !== id));
    if (this.active() === id) this.active.set(this.tabs()[0]?.id ?? '');
  }
}
