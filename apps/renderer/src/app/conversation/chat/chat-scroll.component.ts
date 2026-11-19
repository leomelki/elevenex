import {
  afterNextRender,
  afterEveryRender,
  contentChildren,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
  ElementRef,
} from "@angular/core";
import {
  ButtonComponent,
  IconComponent,
  TooltipDirective,
} from "../../ui";
import { MessageComponent } from "./message.component";
import { ChatLoadingComponent } from './chat-loading.component';
import { ChatHistoryScroll } from "./chat-history-scroll";
import { ChatSendScroll } from "./chat-send-scroll";
interface Reminder {
  readonly id: string;
  readonly text: string;
}
/** Resting on the reminder this long reads as intent; passing over it doesn't.
 * The capsule's charge transition in CSS lasts exactly as long. */
const PEEK_DELAY = 320;
const historyMargin = (height: number) => Math.min(480, height * 0.75);
@Component({
  selector: "ex-chat-scroll",
  imports: [ButtonComponent, IconComponent, TooltipDirective, ChatLoadingComponent],
  templateUrl: "./chat-scroll.component.html",
  styleUrl: "./chat-scroll.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatScrollComponent {
  private readonly messageViews = contentChildren(MessageComponent, { descendants: true });
  private readonly mounted = new WeakSet<MessageComponent>();
  private contentReady = false;
  private renderedMessages?: readonly MessageComponent[];
  private paintedTail?: { readonly element: Element; readonly top: number };
  private sendScroll?: ChatSendScroll;
  private arrivingMessages: readonly MessageComponent[] = [];
  readonly historyBefore = input(false);
  readonly historyAfter = input(false);
  readonly historyLoading = input(false);
  readonly progressiveLoading = input(false);
  readonly initialHistoryPrefetch = input(true);
  readonly historyError = input("");
  readonly historyRevision = input(0);
  readonly historyRequested = output<"before" | "following">();
  readonly historyCancelled = output<void>();
  readonly latestRequested = output<void>();
  private readingAnchor?: {
    readonly element: Element;
    readonly top: number;
    readonly rowId: string | null;
    readonly anchorId: string | null;
  };
  private paintedScroll = { top: 0, height: 0 };
  private historyScroll?: ChatHistoryScroll;
  private paintedRevision = 0;
  private historyPending = false;
  private lastHistoryDirection: "before" | "following" = "before";
  private historyBudget = 0;
  private requestedHeight = 0;
  private disclosure?: {
    readonly anchor: HTMLElement;
    readonly turn: Element;
    readonly top: number;
    settledFrames: number;
  };
  private historyIntent: "before" | "following" = "before";
  onViewportWheel(event: WheelEvent): void {
    if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    this.historyIntent = event.deltaY < 0 ? "before" : "following";
    this.onViewportInteraction();
  }
  onViewportInteraction(): void {
    this.disclosure = undefined;
    this.historyBudget = 4;
    this.interruptSendReveal();
    if (this.contentReady) this.scheduleMeasure();
  }

  /** Inline evidence grows below its control, even when the reply was pinned
   * to the end. Its layout is also independent of new-message indicators. */
  keepDisclosurePosition(anchor: HTMLElement): void {
    const turn = anchor.closest('ex-turn');
    if (!this.contentReady || !turn || !this.host.contains(anchor)) return;
    if (this.disclosure?.anchor === anchor) this.disclosure.settledFrames = 0;
    else this.disclosure = {
      anchor, turn, settledFrames: 0,
      top: anchor.getBoundingClientRect().top - this.viewport().nativeElement.getBoundingClientRect().top,
    };
    this.scheduleMeasure();
  }

  private rememberPosition(): void {
    if (!this.contentReady) return;
    let tail = this.content().nativeElement.lastElementChild;
    // Projection slots can leave a persistent empty decision wrapper at the
    // bottom. Anchoring that wrapper would jump straight over the new exchange.
    while (tail && !tail.matches('ex-turn, [data-user-message]'))
      tail = tail.previousElementSibling;
    this.paintedTail = tail ? { element: tail, top: tail.getBoundingClientRect().top } : undefined;
  }

  private revealArrivals(): void {
    const messages = this.messageViews();
    if (messages === this.renderedMessages) return;
    this.renderedMessages = messages;
    if (this.arrivingMessages.length && this.arrivingMessages.every(message => !message.element.isConnected))
      this.interruptSendReveal();
    const arrivals = messages.filter(message => !this.mounted.has(message));
    if (!arrivals.length) return;
    const fresh = arrivals.filter(message => message.isNew() && message.role() === "user");
    if (fresh.length) {
      this.disclosure = undefined;
      this.interruptSendReveal();
      this.historyScroll?.finish();
      const viewport = this.viewport().nativeElement;
      const anchor = this.paintedTail;
      // A bounded history refresh can remove rows above us in the same render.
      // Preserve the last painted row, including the browser's anchoring offset.
      const from = Math.max(0, anchor?.element.isConnected
        ? viewport.scrollTop + anchor.element.getBoundingClientRect().top - anchor.top
        : viewport.scrollTop);
      const end = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      this.arrivingMessages = fresh;
      if (Math.abs(end - from) > 1 && !this.reducedMotion() && typeof viewport.animate === "function") {
        const style = getComputedStyle(viewport);
        this.atEnd.set(true);
        this.unread.set(false);
        this.sendScroll = new ChatSendScroll(
          viewport, from,
          parseFloat(style.getPropertyValue("--dur-glide")) || 340,
          style.getPropertyValue("--ease-in-out").trim() || "ease-in-out",
          parseFloat(style.getPropertyValue("--dur-fast")) || 140,
          () => {
            this.sendScroll = undefined;
            this.lastScrollHeight = viewport.scrollHeight;
            this.updatePosition();
            this.scheduleMeasure();
          },
        );
      } else {
        viewport.scrollTop = viewport.scrollHeight;
        this.updatePosition();
      }
      this.lastScrollHeight = viewport.scrollHeight;
    }
    for (const message of arrivals) {
      this.mounted.add(message);
      message.playArrival();
    }
  }

  interruptSendReveal(): void {
    this.sendScroll?.cancel();
    this.sendScroll = undefined;
    for (const message of this.arrivingMessages) message.finishArrival();
    this.arrivingMessages = [];
    if (this.contentReady) this.updatePosition();
  }

  onViewportKey(event: KeyboardEvent): void {
    if (event.target === event.currentTarget &&
      ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      this.historyIntent = ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)
        ? "before" : "following";
      this.onViewportInteraction();
    }
  }
  readonly startAtEnd = input(true);
  readonly reminder = input(true);
  readonly activeExchange = output<string>();
  readonly atEnd = signal(true);
  readonly pin = signal<Reminder | null>(null);
  /** One line at rest; resting the pointer on it (or focusing it) reveals three. */
  readonly peek = signal(false);
  /** The pointer rests on a clipped prompt: the capsule charges before it opens. */
  readonly arming = signal(false);
  private peekTimer: ReturnType<typeof setTimeout> | null = null;
  private surfaceMorph: Animation | null = null;
  /** Keyed by prompt so a different exchange swaps its text instead of editing it. */
  readonly pinQuotes = computed(() => {
    const pin = this.pin();
    return pin ? [pin] : [];
  });
  /** First paint is simply there; later appearances slide in. */
  private readonly motionReady = signal(false);
  /** Read when the reminder changes. Under reduced motion no motion class is
   * applied at all, since an enter class without an animation never clears. */
  private readonly motionAllowed = signal(true);
  readonly reminderMotion = computed(() => this.motionReady() && this.motionAllowed());
  /** Only a change between two exchanges blurs text; a fresh reminder slides as one. */
  readonly quoteMotion = signal(false);
  readonly unread = signal(false);
  readonly returnLabel = computed(() =>
    this.unread() ? "New messages. Scroll to bottom" : "Scroll to bottom",
  );
  readonly viewport =
    viewChild.required<ElementRef<HTMLDivElement>>("viewport");
  readonly content = viewChild.required<ElementRef<HTMLDivElement>>("content");
  private readonly track = viewChild.required<ElementRef<HTMLDivElement>>("track");
  private readonly reminderElement = viewChild<ElementRef<HTMLElement>>("reminderElement");
  private readonly destroy = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private messages: HTMLElement[] = [];
  private scrollbarWidth = -1;
  private frame: number | null = null;
  private lastActive = "";
  private lastScrollHeight = 0;
  private lastViewportHeight = 0;
  private highlight: Animation | null = null;
  private readonly motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  constructor() {
    effect(() => {
      // The owner decides whether its opening window needs filling. Explicit
      // scroll intent replenishes the budget independently of that policy.
      this.historyBudget = this.initialHistoryPrefetch() ? 4 : 0;
      if (this.contentReady) this.scheduleMeasure();
    });
    effect(() => {
      this.reminder();
      this.historyLoading();
      this.historyError();
      if (this.contentReady) this.scheduleMeasure();
    });
    afterEveryRender(() => {
      if (this.contentReady && this.paintedRevision !== this.historyRevision()) {
        const viewport = this.viewport().nativeElement;
        const anchor = this.readingAnchor;
        const element = this.findReadingAnchor();
        if (this.atEnd() && !this.historyAfter()) {
          // A short tail can prefetch older history while still pinned. Its
          // first partial turn may be replaced when its prompt arrives, so no
          // retained DOM anchor can keep the latest reply in place.
          this.historyScroll?.finish();
          viewport.scrollTop = viewport.scrollHeight;
        } else if (anchor && element && this.historyScroll) {
          // Account for native scroll anchoring instead of adding a height delta
          // twice. This also handles removing content at the opposite edge.
          const top = this.historyScroll.top + element.getBoundingClientRect().top - anchor.top;
          this.historyScroll.restore(this.paintedScroll, top);
        }
        this.paintedRevision = this.historyRevision();
        this.lastScrollHeight = this.historyScroll?.height ?? viewport.scrollHeight;
        this.updatePosition();
      }
      if (!this.historyLoading() && this.historyPending) {
        this.historyPending = false;
        // Hidden work is not progress towards filling the viewport. Repeated
        // reads here can walk an entire long turn without the reader moving.
        if ((this.historyScroll?.height ?? this.viewport().nativeElement.scrollHeight) <= this.requestedHeight)
          this.historyBudget = 0;
        this.scheduleMeasure();
      }
      this.revealArrivals();
      this.rememberPosition();
      if (this.contentReady) this.rememberReadingAnchor();
    });
    this.destroy.onDestroy(() => {
      this.endPeek();
      this.surfaceMorph?.cancel();
      this.highlight?.cancel();
      this.historyScroll?.cancel();
      this.sendScroll?.cancel();
      for (const message of this.arrivingMessages) message.finishArrival();
    });
    afterNextRender(() => {
      this.contentReady = true;
      const viewport = this.viewport().nativeElement;
      const content = this.content().nativeElement;
      this.historyScroll = new ChatHistoryScroll(viewport, this.track().nativeElement, content, this.motion);
      this.refreshMessages();
      this.atEnd.set(this.startAtEnd());
      if (this.startAtEnd()) viewport.scrollTop = viewport.scrollHeight;
      this.lastScrollHeight = viewport.scrollHeight;
      this.lastViewportHeight = viewport.clientHeight;
      const resize = new ResizeObserver(() => this.scheduleMeasure());
      resize.observe(content);
      resize.observe(viewport);
      const mutations = new MutationObserver((records) => {
        if (
          records.some(
            (record) =>
              Array.from(record.addedNodes).some(
                (node) =>
                  node instanceof HTMLElement &&
                  (node.matches("[data-user-message]") ||
                    node.querySelector("[data-user-message]")),
              ) ||
              Array.from(record.removedNodes).some(
                (node) =>
                  node instanceof HTMLElement &&
                  (node.matches("[data-user-message]") ||
                    node.querySelector("[data-user-message]")),
              ),
          )
        )
          this.refreshMessages();
        this.scheduleMeasure();
      });
      mutations.observe(content, { childList: true, subtree: true });
      this.destroy.onDestroy(() => {
        resize.disconnect();
        mutations.disconnect();
        if (this.frame !== null) cancelAnimationFrame(this.frame);
      });
      this.measure();
      afterNextRender(() => this.motionReady.set(true), { injector: this.injector });
    });
  }
  onScroll(): void {
    if (!this.sendScroll) this.updatePosition();
    this.cancelDistantHistory();
    this.rememberPosition();
    this.rememberReadingAnchor();
    this.scheduleMeasure();
  }
  private updatePosition(): void {
    const viewport = this.viewport().nativeElement;
    const height = this.historyScroll?.height ?? viewport.scrollHeight;
    const top = this.historyScroll?.top ?? viewport.scrollTop;
    this.atEnd.set(
      !this.historyAfter() && height - top - viewport.clientHeight < 40,
    );
    if (this.atEnd()) this.unread.set(false);
  }
  startPeek(event: PointerEvent): void {
    // Touch has no resting pointer; a tap is a jump, not a peek. A prompt that
    // already fits has nothing to reveal, so it must not promise to open.
    if (event.pointerType !== "mouse" || this.peekTimer !== null || this.peek() || !this.promptClipped()) return;
    this.arming.set(!this.reducedMotion());
    this.peekTimer = setTimeout(() => {
      this.peekTimer = null;
      this.setPeek(true);
    }, PEEK_DELAY);
  }
  /** Keyboard focus opens at once; a click's focus doesn't. */
  peekOnFocus(event: FocusEvent): void {
    if (event.target instanceof HTMLElement && event.target.matches(":focus-visible") && this.promptClipped())
      this.setPeek(true);
  }
  endPeek(): void {
    if (this.peekTimer !== null) clearTimeout(this.peekTimer);
    this.peekTimer = null;
    this.setPeek(false);
  }
  private promptClipped(): boolean {
    const quote = this.reminderElement()?.nativeElement.querySelector<HTMLElement>(".quote:not(.quote-leave)");
    return !!quote && quote.scrollHeight > quote.clientHeight + 1;
  }
  private setPeek(open: boolean): void {
    this.arming.set(false);
    if (this.peek() === open) return;
    // Opening releases the charge on a spring; closing settles without bounce.
    if (this.pin() && !this.reducedMotion())
      this.morphSurface(open ? "--dur-deliberate" : "--dur-base", open ? "--ease-spring" : "--ease-out");
    this.peek.set(open);
  }
  scrollToMessage(id: string): void {
    this.disclosure = undefined;
    this.interruptSendReveal();
    this.historyScroll?.finish();
    const target = this.messages.find(
      (message) => message.dataset["userMessage"] === id,
    );
    if (!target) return;
    const viewport = this.viewport().nativeElement;
    const top =
      target.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top +
      viewport.scrollTop;
    viewport.scrollTo({
      top: Math.max(0, top - 24),
      behavior: this.reducedMotion() ? "instant" : "smooth",
    });
    if (!this.reducedMotion()) {
      this.highlight?.cancel();
      this.highlight = target.animate(
        [{ boxShadow: "var(--focus-ring)" }, { boxShadow: "none" }],
        { duration: 700, easing: "ease-out" },
      );
    }
  }
  scrollToEnd(behavior: ScrollBehavior = "smooth"): void {
    this.disclosure = undefined;
    this.interruptSendReveal();
    this.historyScroll?.finish();
    const viewport = this.viewport().nativeElement;
    // Keep the return control present until native smooth scrolling arrives.
    // Claiming the end early would hide/reveal it on intermediate scroll events.
    if (behavior === "instant" || this.reducedMotion()) {
      viewport.scrollTop = viewport.scrollHeight;
      this.updatePosition();
    } else viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }
  returnToEnd(): void {
    // The control becomes inert at the end. Move focus to the transcript first
    // so keyboard readers retain a useful location after it leaves.
    this.viewport().nativeElement.focus({ preventScroll: true });
    if (this.historyAfter()) this.latestRequested.emit();
    else this.scrollToEnd();
  }
  retryHistory(): void {
    this.viewport().nativeElement.focus({ preventScroll: true });
    this.historyBudget = 4;
    this.requestHistory(this.lastHistoryDirection);
  }
  private rememberReadingAnchor(): void {
    const viewport = this.viewport().nativeElement;
    this.paintedScroll = { top: viewport.scrollTop, height: viewport.scrollHeight };
    const top = viewport.getBoundingClientRect().top;
    const children = this.content().nativeElement.querySelectorAll("[data-chat-anchor]");
    // The DOM is bounded by the connected owner's transcript window. Keep the
    // first visible stable row, including a reply whose prompt is off screen.
    let low = 0, high = children.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (children[middle]!.getBoundingClientRect().bottom <= top) low = middle + 1;
      else high = middle;
    }
    const turn = children[low];
    // A turn may grow above the answer as older work arrives. Anchor the actual
    // visible row inside it, rather than the turn's unchanged outer edge.
    const row = turn && Array.from(turn.querySelectorAll('[data-chat-row]')).find(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.height > 0 && bounds.bottom > top;
    });
    const element = row ?? turn;
    this.readingAnchor = element ? { element, top: element.getBoundingClientRect().top,
      rowId: element.getAttribute('data-chat-row'),
      anchorId: element.getAttribute('data-chat-anchor') } : undefined;
  }
  private findReadingAnchor(): Element | undefined {
    const anchor = this.readingAnchor;
    if (!anchor || anchor.element.isConnected) return anchor?.element;
    const key = anchor.rowId ? 'data-chat-row' : 'data-chat-anchor';
    const id = anchor.rowId ?? anchor.anchorId;
    if (!id) return undefined;
    return this.content().nativeElement.querySelector(`[${key}="${CSS.escape(id)}"]`) ?? undefined;
  }
  private requestHistory(direction: "before" | "following"): void {
    if (this.historyLoading() || this.historyPending) return;
    this.interruptSendReveal();
    this.rememberReadingAnchor();
    this.lastHistoryDirection = direction;
    this.historyPending = true;
    // A collapsed page may add no scrollable content. Chaining more reads in
    // that case can evict the answer still in view. Overflowing conversations
    // prefetch once per gesture; only an underfilled viewport chains pages.
    const viewport = this.viewport().nativeElement;
    this.requestedHeight = this.historyScroll?.height ?? viewport.scrollHeight;
    this.historyBudget = this.requestedHeight > viewport.clientHeight ? 0 : this.historyBudget - 1;
    // Loading above a pinned tail must not relinquish end following. An actual
    // reader scroll updates atEnd normally while the request is pending.
    if (direction === 'following') this.atEnd.set(false);
    this.historyRequested.emit(direction);
  }
  private cancelDistantHistory(): void {
    if (!this.historyPending || !this.historyLoading() || !this.historyScroll) return;
    const height = this.viewport().nativeElement.clientHeight;
    const { top, height: contentHeight } = this.historyScroll;
    const distance = this.lastHistoryDirection === "before" ? top : contentHeight - top - height;
    // A quick reversal during a held read can put the reader inside the part
    // of the window that the pending page would evict. Allow nearby scrolling.
    if (distance <= height + historyMargin(height)) return;
    this.historyPending = false;
    this.historyBudget = 0;
    this.historyCancelled.emit();
  }
  private refreshMessages(): void {
    this.messages = Array.from(
      this.content().nativeElement.querySelectorAll<HTMLElement>(
        "[data-user-message]",
      ),
    );
  }
  private scheduleMeasure(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.measure();
    });
  }
  private measure(): void {
    const viewport = this.viewport().nativeElement;
    const revealing = this.maintainDisclosurePosition(viewport);
    const height = this.historyScroll?.height ?? viewport.scrollHeight;
    const top = this.historyScroll?.top ?? viewport.scrollTop;
    const contentChanged = height !== this.lastScrollHeight;
    const resized = viewport.clientHeight !== this.lastViewportHeight;
    if (this.sendScroll) this.sendScroll.reconcile();
    else if ((resized || (contentChanged && !revealing)) && this.atEnd()) {
      this.historyScroll?.finish();
      viewport.scrollTop = viewport.scrollHeight;
    } else if (contentChanged && !revealing) this.unread.set(true);
    this.lastScrollHeight = height;
    this.lastViewportHeight = viewport.clientHeight;
    if (!this.sendScroll) this.updatePosition();
    const scrollbar = viewport.offsetWidth - viewport.clientWidth;
    if (scrollbar !== this.scrollbarWidth) {
      // The reminder's scrim stops at the scrollbar instead of fading it.
      this.scrollbarWidth = scrollbar;
      this.host.style.setProperty("--scrollbar-width", `${scrollbar}px`);
    }
    const bounds = viewport.getBoundingClientRect();
    const candidate = this.promptAt(bounds.top + 16);
    const id = candidate?.dataset["userMessage"] ?? "";
    if (id !== this.lastActive) {
      this.lastActive = id;
      this.activeExchange.emit(id);
    }
    this.rememberPosition();
    this.measureReminder(bounds);
    if (!this.historyError() && !this.sendScroll && this.historyBudget > 0 && viewport.clientHeight > 0) {
      // Prefetch before an edge is reached. One owner request remains in flight;
      // successful short pages can keep filling a tall viewport automatically.
      const margin = historyMargin(viewport.clientHeight);
      const underfilled = height <= viewport.clientHeight;
      if ((!underfilled || this.historyIntent === "before") && this.historyBefore() && top < margin &&
          (!this.atEnd() || underfilled))
        this.requestHistory("before");
      else if ((!underfilled || this.historyIntent === "following") && this.historyAfter() &&
          height - top - viewport.clientHeight < margin)
        this.requestHistory("following");
    }
  }
  private maintainDisclosurePosition(viewport: HTMLDivElement): boolean {
    const disclosure = this.disclosure;
    if (!disclosure || !disclosure.anchor.isConnected || this.sendScroll) {
      this.disclosure = undefined;
      return false;
    }
    const top = disclosure.anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    if (Math.abs(top - disclosure.top) > 1) viewport.scrollTop += top - disclosure.top;
    const animating = disclosure.turn.getAnimations?.({ subtree: true }).some(animation =>
      animation.playState !== 'finished' && animation.playState !== 'idle' &&
      Number.isFinite(animation.effect?.getComputedTiming().endTime));
    // Give newly rendered CSS transitions a paint to start. ResizeObserver
    // drives the rest of the movement, including interrupted folds.
    if (animating) disclosure.settledFrames = 0;
    else if (++disclosure.settledFrames < 2) this.scheduleMeasure();
    else this.disclosure = undefined;
    return true;
  }
  private measureReminder(viewport: DOMRect): void {
    // Match the legacy chat's reading probe: keep the previous prompt's context
    // until the next prompt reaches the upper reading area, not the bottom edge.
    const probe = viewport.top + Math.min(160, Math.max(48, viewport.height * 0.28));
    const candidate = this.promptAt(probe);
    const id = candidate?.dataset["userMessage"] ?? "";
    const retained = this.pin()?.id === id;
    // A small buffer prevents a barely clipped prompt from immediately being
    // repeated. Relax it by 24px on return to avoid flickering at the boundary.
    const distance = Math.min(96, Math.max(48, viewport.height * 0.12));
    const useful = this.reminder() && candidate &&
      viewport.height >= 240 &&
      viewport.top - candidate.getBoundingClientRect().bottom >= distance - (retained ? 24 : 0);
    const text = useful
      ? (candidate.querySelector(".content")?.textContent ?? candidate.textContent)?.trim() ?? ""
      : "";
    this.setReminder(text ? { id, text } : null);
  }
  private promptAt(y: number): HTMLElement | undefined {
    let low = 0, high = this.messages.length - 1;
    let candidate: HTMLElement | undefined;
    // Binary search the cached ordered prompts; scrolling stays O(log n).
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const message = this.messages[middle];
      if (message && message.getBoundingClientRect().top <= y) {
        candidate = message;
        low = middle + 1;
      } else high = middle - 1;
    }
    return candidate;
  }
  private setReminder(reminder: Reminder | null): void {
    if (!reminder && this.reminderElement()?.nativeElement.contains(document.activeElement))
      this.viewport().nativeElement.focus({ preventScroll: true });
    const current = this.pin();
    if (current?.id === reminder?.id && current?.text === reminder?.text) return;
    const motion = !this.reducedMotion();
    const swap = !!current && !!reminder && current.id !== reminder.id;
    this.motionAllowed.set(motion);
    this.quoteMotion.set(motion && swap);
    if (!reminder) this.endPeek();
    if (motion && swap) this.morphSurface("--dur-slow", "--ease-out");
    this.pin.set(reminder);
  }
  /** The capsule sizes to its prompt. Ease its box from the painted size to the
   * next one: between two prompts' widths, or between one and three lines. */
  private morphSurface(duration: string, easing: string): void {
    const surface = this.reminderElement()?.nativeElement.querySelector<HTMLElement>(".surface");
    if (!surface || typeof surface.animate !== "function") return;
    // Layout sizes ignore the charge's scale but include a running morph.
    const from = { width: surface.offsetWidth, height: surface.offsetHeight };
    this.surfaceMorph?.cancel();
    afterNextRender(() => {
      const to = { width: surface.offsetWidth, height: surface.offsetHeight };
      if (!surface.isConnected ||
        (Math.abs(to.width - from.width) < 2 && Math.abs(to.height - from.height) < 2)) return;
      const style = getComputedStyle(surface);
      this.surfaceMorph = surface.animate(
        [
          { width: `${from.width}px`, height: `${from.height}px`, overflow: "clip" },
          { width: `${to.width}px`, height: `${to.height}px`, overflow: "clip" },
        ],
        {
          duration: parseFloat(style.getPropertyValue(duration)) || 280,
          easing: style.getPropertyValue(easing).trim() || "ease-out",
        },
      );
    }, { injector: this.injector });
  }
  private reducedMotion(): boolean {
    return this.motion?.matches ?? false;
  }
}
