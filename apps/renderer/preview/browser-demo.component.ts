import { afterRenderEffect, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, output, signal, viewChild } from '@angular/core';
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
  protected readonly hovered = signal<BrowserTarget | undefined>(undefined);
  protected readonly picked = signal<BrowserTarget | undefined>(undefined);
  protected readonly active = signal('checkout');
  protected readonly tabs = signal<readonly BrowserTab[]>([
    { id: 'checkout', title: 'Checkout · Shop', url: 'localhost:3000/checkout', server: 'web', by: 'agent' },
    { id: 'docs', title: 'API docs', url: 'docs.example.com', by: 'you' },
  ]);
  protected readonly action = signal<BrowserTarget | undefined>(undefined);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly checkout = viewChild<ElementRef<HTMLElement>>('checkout');
  private readonly pay = viewChild<unknown, ElementRef<HTMLButtonElement>>('pay', { read: ElementRef });
  private nextTab = 0;
  private pickedNode?: HTMLElement;

  constructor() {
    const destroy = inject(DestroyRef);
    let observer: ResizeObserver | undefined;
    let stopPicking: (() => void) | undefined;
    afterRenderEffect(() => {
      const checkout = this.checkout()?.nativeElement;
      const pay = this.pay()?.nativeElement;
      if (!checkout || !pay || observer) return;
      // Re-measure when phone width or fonts change rather than hard-coding a ring.
      observer = new ResizeObserver(() => {
        const target = this.measure(pay);
        if (target) this.action.set({ ...target, label: 'Checking “Pay €24.00”' });
        // A reflow (phone width) moves the picked element; keep its ring on it.
        const picked = this.picked(), node = this.pickedNode;
        const moved = picked && node ? this.measure(node) : undefined;
        if (picked && moved) this.picked.set({ ...picked, ...moved });
      });
      observer.observe(checkout);
      observer.observe(pay);
      stopPicking = this.listenForPicks(checkout);
    });
    destroy.onDestroy(() => { observer?.disconnect(); stopPicking?.(); });
  }

  protected selectDriver(driver: BrowserDriver): void { this.driver.set(driver); this.setPicking(false); }
  /** Picking takes the page from the agent, as the desktop's control lease does. */
  protected setPicking(enabled: boolean): void {
    this.picking.set(enabled); this.picked.set(undefined); this.hovered.set(undefined); this.pickedNode = undefined;
    if (enabled && this.driver() === 'agent') this.driver.set('you');
  }
  protected asked(text: string): void { this.event.emit('Ask: ' + text); this.setPicking(false); }
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

  /** Sample elements name their selector and source line, as a source-mapped page would. */
  private listenForPicks(checkout: HTMLElement): () => void {
    const element = (event: Event) => event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pick]') : null;
    const describe = (node: HTMLElement) => {
      const target = this.measure(node);
      return target ? { ...target, label: node.dataset['pick'] ?? node.localName, file: node.dataset['source'] } : undefined;
    };
    const active = () => this.picking() && !this.picked();
    const move = (event: PointerEvent) => {
      if (!active()) return;
      const node = element(event), current = this.hovered();
      const next = node ? describe(node) : undefined;
      if (next?.label !== current?.label || next?.x !== current?.x || next?.y !== current?.y) this.hovered.set(next);
    };
    const leave = () => { if (active()) this.hovered.set(undefined); };
    // The page never receives a click while picking, like the desktop's input interception.
    const click = (event: MouseEvent) => {
      if (!active()) return;
      event.preventDefault(); event.stopPropagation();
      const node = element(event);
      if (node) { this.pickedNode = node; this.picked.set(describe(node)); this.hovered.set(undefined); }
    };
    checkout.addEventListener('pointermove', move);
    checkout.addEventListener('pointerleave', leave);
    checkout.addEventListener('click', click, { capture: true });
    return () => {
      checkout.removeEventListener('pointermove', move);
      checkout.removeEventListener('pointerleave', leave);
      checkout.removeEventListener('click', click, { capture: true });
    };
  }
  private measure(node: HTMLElement): Omit<BrowserTarget, 'label'> | undefined {
    const page = this.host.nativeElement.querySelector('.page');
    if (!page) return undefined;
    const origin = page.getBoundingClientRect(), target = node.getBoundingClientRect();
    return { x: target.x - origin.x + page.scrollLeft, y: target.y - origin.y + page.scrollTop, w: target.width, h: target.height };
  }
}
