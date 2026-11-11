import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { ButtonComponent, EaseSwapComponent, FoldComponent, IconComponent, IconButtonComponent, KbdComponent, StatusGlyphComponent, type Status } from '../ui';
import { BrowserDriver, BrowserQuestion, BrowserStep, BrowserTab, BrowserTarget, ViewTab, type ViewTabMove, type BrowserCursor } from './view.models';
import { ViewTabsComponent } from './view-tabs.component';
import { CdkMenuTrigger } from '@angular/cdk/menu';
import { DropdownMenuComponent, DropdownItemComponent, TooltipDirective } from '../ui';

/** Page and question-card measurements, in the page's scrolled CSS coordinates. */
interface QuestionLayout {
  readonly pageWidth: number; readonly pageHeight: number; readonly scrollLeft: number; readonly scrollTop: number;
  readonly cardWidth: number; readonly cardHeight: number;
}
/** Where the question card sits: under or over its element, or docked at the visible page's top or bottom edge. */
interface QuestionPlacement { readonly side: 'below' | 'above' | 'top' | 'bottom'; readonly left: number; readonly top: number; readonly origin: string }

/** The ring is drawn this far outside its element. */
const RING_OUTSET = 4;
/** Space between the ring and the question card. */
const CARD_GAP = 8;
/** Space the card keeps from the visible page's edges. */
const CARD_MARGIN = 12;
/** Narrower pages dock the card at their foot rather than beside the element. */
const DOCK_BELOW_WIDTH = 400;
/** Room kept for the draft to grow, so the card does not flip sides while you type. */
const GROWTH_ROOM = 40;
/** Height a ring label needs above its ring. */
const LABEL_ROOM = 24;

/** Browser chrome. The owner supplies a trusted platform adapter through the preview slot. */
@Component({
  selector: 'ex-browser-view',
  imports: [ButtonComponent, EaseSwapComponent, FoldComponent, IconComponent, IconButtonComponent, KbdComponent, ViewTabsComponent, StatusGlyphComponent, CdkMenuTrigger, DropdownMenuComponent, DropdownItemComponent, TooltipDirective],
  templateUrl: './browser-view.component.html',
  styleUrl: './browser-view.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserViewComponent {
  readonly streaming = input(false);
  readonly localTabsAvailable = input(false);
  readonly localOnly = input(false);
  readonly trafficViaServer = input(false);
  readonly localAdded = output<void>();
  protected readonly localDetails = computed(() => `Runs on this device. ${this.trafficViaServer() ? 'Web traffic goes through the task server.' : 'Web traffic uses this device.'} Agents cannot see or control this page. Sign-ins use a separate local profile.`);
  protected readonly location = computed(() => this.streaming() ? 'Streaming' : this.trafficViaServer() ? 'Local · Proxied' : 'Local');
  protected readonly locationDetails = computed(() => this.localOnly() ? this.localDetails() : this.streaming() ? 'Browser runs on the task server and streams to this device.' : 'Browser runs on this device.');
  readonly showTabs = input(true);
  readonly controlsDisabled = input(false);
  readonly pickerAvailable = input(true);
  readonly detachable = input(false);
  readonly detachBusy = input(false);
  readonly detachLabel = input('Open tab in new window');
  readonly detachRequested = output<void>();
  readonly reorderable = input(false);
  readonly tabsBusy = input(false);
  readonly tabMoved = output<ViewTabMove>();
  readonly tabWindowRequested = output<string>();
  readonly tabs = input<readonly BrowserTab[]>([]);
  readonly active = input<string>();
  readonly clipPreview = input(false);
  readonly keepPreviewMounted = input(false);
  readonly driver = input<BrowserDriver>('you');
  readonly step = input<BrowserStep>();
  readonly action = input<BrowserTarget>();
  readonly cursor = input<BrowserCursor>();
  readonly agentWaiting = input(false);
  readonly picking = input(false);
  /** The element under the pointer while picking, when the owner can inspect on hover. */
  readonly hovered = input<BrowserTarget>();
  readonly capturePending = input(false);
  readonly pickerReady = input(true);
  private readonly pressedTarget = signal<BrowserTarget | undefined>(undefined);
  private readonly pressed = signal(false);
  protected readonly pickingBusy = computed(() => this.capturePending() || this.pressed());
  protected readonly hoverTarget = computed(() => this.pressedTarget() ?? this.hovered());
  readonly picked = input<BrowserTarget>();
  readonly errors = input(0);
  readonly errorText = input('');
  readonly width = input<'full' | 'phone'>('full');
  readonly needsTitle = input('The agent needs you here');
  readonly needsText = input('Complete the step, then hand control back to the agent.');
  readonly canGoBack = input(false);
  readonly canGoForward = input(false);
  readonly loading = input(false);
  readonly addressEditable = input(false);
  readonly pageFocusAvailable = input(true);
  readonly askLabel = input('Ask');
  /**
   * `ask` grows the question card from the picked element; `pin` leaves the
   * picked ring alone so the owner can stage the element elsewhere (the chat).
   */
  readonly pickMode = input<'ask' | 'pin'>('ask');
  /** One short line in the question card saying what the question carries. */
  readonly askNote = input('');
  readonly navigated = output<string>();
  protected readonly addressDraft = signal<string | null>(null);
  private addressTab?: string;
  private readonly addressInput = viewChild<ElementRef<HTMLInputElement>>('address');
  readonly selected = output<string>();
  readonly closed = output<string>();
  readonly added = output<void>();
  /** Explicitly block the agent. Page interaction is owned by the platform adapter. */
  readonly takeOverRequested = output<void>();
  readonly pageFocusRequested = output<void>();
  readonly handBackRequested = output<void>();
  readonly pickingChange = output<boolean>();
  readonly asked = output<BrowserQuestion>();
  readonly sendErrorsRequested = output<void>();
  readonly widthChange = output<'full' | 'phone'>();
  readonly backRequested = output<void>();
  readonly forwardRequested = output<void>();
  readonly reloadRequested = output<void>();
  readonly moreRequested = output<void>();
  protected readonly locationLabel = computed(() => this.location() + ' browser. ' + (this.localOnly() ? 'Open browser details.' : 'Focus page. Shift+Escape returns to browser controls.'));
  protected readonly askText = signal('');
  protected readonly current = computed(() => this.tabs().find(tab => tab.id === this.active()) ?? this.tabs()[0]);
  protected readonly tabItems = computed<readonly ViewTab[]>(() => this.tabs().map(tab => ({ ...tab, icon: tab.icon ?? 'globe', agent: tab.by === 'agent', agentDriving: this.driver() === 'agent' && this.step()?.status !== 'done' && this.step()?.status !== 'error' && tab.id === this.current()?.id })));
  /** Choosing an element: the page shows the picking frame and hint until one is picked. */
  protected readonly pointing = computed(() => !!this.current() && this.picking() && !this.picked());
  /** Point and ask is in use, from choosing an element until its question is sent or dismissed. */
  protected readonly pointAndAsk = computed(() => this.picking() || !!this.picked());
  protected readonly target = computed(() => this.picked() ?? (this.driver() === 'agent' && !this.pointing() ? this.action() : undefined));
  protected readonly cursorTransform = computed(() => {
    const cursor = this.cursor();
    if (cursor) return `translate(${this.coordinate(cursor.x)}px, ${this.coordinate(cursor.y)}px)`;
    const target = this.action();
    return target ? `translate(${this.position(target.x) + this.coordinate(target.w) * .62}px, ${this.position(target.y) + this.coordinate(target.h) * .55}px)` : '';
  });
  protected readonly cursorPulses = computed(() => this.cursor()?.pulse ? [this.cursor()!.pulse] : []);
  protected readonly stepStatus = computed<Status>(() => {
    const status = this.step()?.status;
    return status === 'error' ? 'failed' : status === 'done' ? 'done' : status === 'waiting' ? 'queued' : 'running';
  });
  protected readonly stepStatusLabel = computed(() => ({ running: 'Running', queued: 'Waiting', done: 'Done', failed: 'Failed', attention: 'Needs you', review: 'Review' })[this.stepStatus()]);
  protected readonly stepDots = computed(() => {
    const step = this.step();
    if (!step?.total || !Number.isFinite(step.total) || step.total < 1) return [];
    const count = Math.min(12, Math.floor(step.total));
    // Keep long workflows bounded while still showing their current position.
    const current = Math.min(count - 1, Math.max(0, Math.floor((step.n - 1) * count / step.total)));
    return Array.from({ length: count }, (_, index) => index < current || (step.status === 'done' && index === current) ? 'done' : index === current ? 'now' : 'next');
  });
  private readonly questionLayout = signal<QuestionLayout | undefined>(undefined);
  /** Beside the element when it fits (under it first), otherwise docked at the visible page's far edge. */
  protected readonly cardPlacement = computed<QuestionPlacement | undefined>(() => {
    const target = this.picked(), layout = this.questionLayout();
    return target && layout ? placeQuestion(target, layout) : undefined;
  });
  private readonly askInput = viewChild<ElementRef<HTMLTextAreaElement>>('askInput');
  private readonly questionCard = viewChild<ElementRef<HTMLElement>>('questionCard');
  private readonly page = viewChild<ElementRef<HTMLElement>>('page');
  private readonly pickToggle = viewChild<unknown, ElementRef<HTMLElement>>('pickToggle', { read: ElementRef });
  private readonly driverControl = viewChild<ElementRef<HTMLButtonElement>>('driverControl');
  private readonly moreControl = viewChild<unknown, ElementRef<HTMLElement>>('moreControl', { read: ElementRef });
  private readonly preview = viewChild<ElementRef<HTMLElement>>('preview');
  private previousAskInput?: HTMLTextAreaElement;
  private returnFocus?: HTMLElement;
  private wasPointing = false;

  constructor() {
    let captureWasPending = false;
    afterRenderEffect(onCleanup => {
      const preview = this.preview()?.nativeElement;
      const pending = this.capturePending();
      if (captureWasPending && !pending) { this.pressedTarget.set(undefined); this.pressed.set(false); }
      captureWasPending = pending;
      if (!preview || !this.pointing()) { this.pressedTarget.set(undefined); this.pressed.set(false); return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Capture before streamed-page input stops propagation. This is visual
      // acknowledgement only; the host still owns selection and image capture.
      const press = (event: PointerEvent) => {
        if (event.button !== 0 || pending || !this.pickerReady()) return;
        this.pressed.set(true);
        this.pressedTarget.set(this.hovered());
        clearTimeout(timer);
        timer = setTimeout(() => { this.pressedTarget.set(undefined); this.pressed.set(false); }, 1500);
      };
      const escape = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || event.isComposing) return;
        event.preventDefault(); event.stopPropagation(); this.pickingChange.emit(false);
      };
      preview.addEventListener('pointerdown', press, true);
      preview.addEventListener('keydown', escape, true);
      onCleanup(() => { clearTimeout(timer); preview.removeEventListener('pointerdown', press, true); preview.removeEventListener('keydown', escape, true); });
    });
    afterRenderEffect(() => {
      const id = this.current()?.id;
      if (id !== this.addressTab) { this.addressTab = id; this.addressDraft.set(null); if (id && !this.current()?.url) this.addressInput()?.nativeElement.focus({ preventScroll: true }); }
    });
    afterRenderEffect(() => {
      const input = this.askInput()?.nativeElement;
      if (input && input !== this.previousAskInput) {
        // Focus left inside the page by the pick itself is incidental: return to the toggle instead.
        const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body && !this.page()?.nativeElement.contains(document.activeElement) ? document.activeElement : undefined;
        this.returnFocus = previous ?? this.pickToggle()?.nativeElement.querySelector('button') ?? undefined;
        input.focus({ preventScroll: true });
      } else if (!input && this.previousAskInput && this.returnFocus?.isConnected) {
        this.returnFocus.focus({ preventScroll: true });
        this.returnFocus = undefined;
      }
      this.previousAskInput = input;
    });
    afterRenderEffect(() => {
      // A page shortcut can start picking while focus sits outside the app's
      // controls. Bring it to the page so Escape cancels from anywhere.
      const pointing = this.pointing(), preview = this.preview()?.nativeElement;
      if (pointing && !this.wasPointing && preview && !preview.closest('section')?.contains(document.activeElement)) preview.focus({ preventScroll: true });
      this.wasPointing = pointing;
    });
    afterRenderEffect(onCleanup => {
      const card = this.questionCard()?.nativeElement, page = this.page()?.nativeElement;
      if (!card || !page) { this.questionLayout.set(undefined); return; }
      // Measure before the first paint, then follow page resizes, scrolling and the growing draft.
      const measure = () => {
        const next: QuestionLayout = { pageWidth: page.clientWidth, pageHeight: page.clientHeight, scrollLeft: page.scrollLeft, scrollTop: page.scrollTop, cardWidth: card.offsetWidth, cardHeight: card.offsetHeight };
        const previous = this.questionLayout();
        if (!previous || (Object.keys(next) as (keyof QuestionLayout)[]).some(key => previous[key] !== next[key])) this.questionLayout.set(next);
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(page); observer.observe(card);
      page.addEventListener('scroll', measure, { passive: true });
      onCleanup(() => { observer.disconnect(); page.removeEventListener('scroll', measure); });
    });
  }
  protected position(value: number): number { return Number.isFinite(value) ? value : 0; }
  protected coordinate(value: number): number { return Number.isFinite(value) ? Math.max(0, value) : 0; }
  protected ringTransform(target: BrowserTarget): string { return `translate(${this.position(target.x) - RING_OUTSET}px, ${this.position(target.y) - RING_OUTSET}px)`; }
  /** Labels sit above their ring unless that would put them above the page. */
  protected labelBelow(target: BrowserTarget): boolean { return this.position(target.y) < LABEL_ROOM; }

  focusControls(): void { this.driverControl()?.nativeElement.focus({ preventScroll: true }); }
  /** Stable native trigger for the owning tools modal's motion and focus return. */
  toolsOrigin(): HTMLElement | null { return this.moreControl()?.nativeElement.querySelector('button') ?? null; }
  protected focusPage(): void {
    this.preview()?.nativeElement.focus({ preventScroll: true }); this.pageFocusRequested.emit();
  }
  protected takeOverFromBar(): void { this.takeOverRequested.emit(); }
  protected handBack(): void {
    // Move focus before the owning control's Fold becomes inert and hidden.
    this.driverControl()?.nativeElement.focus({ preventScroll: true });
    this.handBackRequested.emit();
  }
  protected navigateAddress(): void {
    const value = this.addressDraft()?.trim();
    if (value) { this.preview()?.nativeElement.focus({ preventScroll: true }); this.navigated.emit(value); this.addressDraft.set(null); }
  }
  protected togglePointAndAsk(): void { this.pickingChange.emit(!this.pointAndAsk()); }
  protected ask(): void {
    const target = this.picked();
    const tab = this.current();
    const text = this.askText().trim();
    if (!target || !tab || !text) return;
    this.asked.emit({ tabId: tab.id, target, text });
    this.askText.set('');
  }
  protected askKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.ask(); }
  }
  protected questionKeydown(event: KeyboardEvent): void {
    // The card's keys never reach the page or its takeover handler.
    event.stopPropagation();
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); this.dismissQuestion(); }
  }
  protected dismissQuestion(): void {
    // Restore before Angular removes the focused card. A removed focused
    // node otherwise drops focus to body before the after-render callback.
    this.returnFocus?.focus({ preventScroll: true });
    this.pickingChange.emit(false);
  }
  protected keydown(event: KeyboardEvent): void {
    if (this.showTabs() && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') { event.preventDefault(); this.added.emit(); }
    if (this.pickerAvailable() && !this.controlsDisabled() && (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'c') { event.preventDefault(); this.togglePointAndAsk(); }
    if (event.key === 'Escape' && this.pointing()) { event.preventDefault(); this.pickingChange.emit(false); }
  }
}

/** Places the card beside its ring within the visible page, preferring below, then above, then the page edge away from it. */
function placeQuestion(target: BrowserTarget, layout: QuestionLayout): QuestionPlacement {
  const finite = (value: number) => Number.isFinite(value) ? value : 0;
  const x = finite(target.x), y = finite(target.y), w = Math.max(0, finite(target.w)), h = Math.max(0, finite(target.h));
  const viewLeft = layout.scrollLeft + CARD_MARGIN, viewRight = layout.scrollLeft + layout.pageWidth - CARD_MARGIN;
  const viewTop = layout.scrollTop + CARD_MARGIN, viewBottom = layout.scrollTop + layout.pageHeight - CARD_MARGIN;
  const left = Math.max(viewLeft, Math.min(viewRight - layout.cardWidth, x - RING_OUTSET));
  // Grow from the element's centre, so the card visibly comes out of what was picked.
  const originX = Math.max(0, Math.min(layout.cardWidth, x + w / 2 - left));
  const below = y + h + RING_OUTSET + CARD_GAP, above = y - RING_OUTSET - CARD_GAP;
  const visible = y + h > layout.scrollTop && y < layout.scrollTop + layout.pageHeight;
  if (layout.pageWidth >= DOCK_BELOW_WIDTH && visible) {
    if (below + layout.cardHeight + GROWTH_ROOM <= viewBottom) return { side: 'below', left, top: below, origin: `${originX}px 0` };
    if (above - layout.cardHeight - GROWTH_ROOM >= viewTop) return { side: 'above', left, top: above, origin: `${originX}px 100%` };
  }
  // Docked cards take the visible page's width, on the edge away from the element.
  if (y + h / 2 > layout.scrollTop + layout.pageHeight / 2) return { side: 'top', left: viewLeft, top: viewTop, origin: '50% 0' };
  return { side: 'bottom', left: viewLeft, top: viewBottom, origin: '50% 100%' };
}
