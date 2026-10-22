import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { ButtonComponent, EaseSwapComponent, FoldComponent, IconComponent, IconButtonComponent } from '../ui';
import { BrowserDriver, BrowserQuestion, BrowserStep, BrowserTab, BrowserTarget, ViewTab } from './view.models';
import { ViewTabsComponent } from './view-tabs.component';

/** A safe preview host. The owner supplies trusted rendered content, never an arbitrary iframe/webview. */
@Component({
  selector: 'ex-browser-view',
  imports: [ButtonComponent, EaseSwapComponent, FoldComponent, IconComponent, IconButtonComponent, ViewTabsComponent],
  templateUrl: './browser-view.component.html',
  styleUrl: './browser-view.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserViewComponent {
  readonly tabs = input<readonly BrowserTab[]>([]);
  readonly active = input<string>();
  readonly driver = input<BrowserDriver>('you');
  readonly step = input<BrowserStep>();
  readonly action = input<BrowserTarget>();
  readonly agentWaiting = input(false);
  readonly picking = input(false);
  readonly picked = input<BrowserTarget>();
  readonly errors = input(0);
  readonly errorText = input('');
  readonly width = input<'full' | 'phone'>('full');
  readonly needsTitle = input('The agent needs you here');
  readonly needsText = input('Complete the step, then hand control back to the agent.');
  readonly canGoBack = input(false);
  readonly loading = input(false);
  readonly selected = output<string>();
  readonly closed = output<string>();
  readonly added = output<void>();
  readonly takeOverRequested = output<void>();
  readonly handBackRequested = output<void>();
  readonly pickingChange = output<boolean>();
  readonly asked = output<BrowserQuestion>();
  readonly sendErrorsRequested = output<void>();
  readonly widthChange = output<'full' | 'phone'>();
  readonly backRequested = output<void>();
  readonly reloadRequested = output<void>();
  readonly moreRequested = output<void>();
  protected readonly askText = signal('');
  protected readonly current = computed(() => this.tabs().find(tab => tab.id === this.active()) ?? this.tabs()[0]);
  protected readonly tabItems = computed<readonly ViewTab[]>(() => this.tabs().map(tab => ({ ...tab, icon: 'globe', agent: tab.by === 'agent' })));
  protected readonly target = computed(() => this.picked() ?? (this.driver() === 'agent' ? this.action() : undefined));
  protected readonly targetTransform = computed(() => {
    const target = this.target();
    return target ? `translate(${this.coordinate(target.x)}px, ${this.coordinate(target.y)}px)` : '';
  });
  private readonly askInput = viewChild<ElementRef<HTMLTextAreaElement>>('askInput');
  private previousAskInput?: HTMLTextAreaElement;
  private returnFocus?: HTMLElement;

  constructor() {
    afterRenderEffect(() => {
      const input = this.askInput()?.nativeElement;
      if (input && input !== this.previousAskInput) {
        if (document.activeElement instanceof HTMLElement) this.returnFocus = document.activeElement;
        input.focus({ preventScroll: true });
      } else if (!input && this.previousAskInput && this.returnFocus?.isConnected) {
        this.returnFocus.focus({ preventScroll: true });
        this.returnFocus = undefined;
      }
      this.previousAskInput = input;
    });
  }
  protected coordinate(value: number): number { return Number.isFinite(value) ? Math.max(0, value) : 0; }

  protected takeOver(): void { if (this.driver() === 'agent') this.takeOverRequested.emit(); }
  protected ask(): void {
    const target = this.picked();
    const tab = this.current();
    const text = this.askText().trim();
    if (!target || !tab || !text) return;
    this.asked.emit({ tabId: tab.id, target, text });
    this.askText.set('');
  }
  protected askKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.ask(); }
    if (event.key === 'Escape') { event.stopPropagation(); this.pickingChange.emit(false); }
  }
  protected keydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') { event.preventDefault(); this.added.emit(); }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'c') { event.preventDefault(); this.pickingChange.emit(!this.picking()); }
  }
}
