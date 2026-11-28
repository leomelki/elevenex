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
import { ChatHistoryScroll } from "./chat-history-scroll";
import { ChatSendScroll } from "./chat-send-scroll";
import type { ChatHistoryRequest } from "../conversation.models";
interface Reminder {
  readonly id: string;
  readonly text: string;
}
interface ReadingAnchor {
  readonly element: Element;
  readonly top: number;
  readonly rowId: string | null;
  readonly anchorId: string | null;
}
/** Resting on the reminder this long reads as intent; passing over it doesn't.
 * The capsule's charge transition in CSS lasts exactly as long. */
const PEEK_DELAY = 320;
const historyMargin = (height: number) => Math.min(480, height * 0.75);
@Component({
  selector: "ex-chat-scroll",
  imports: [ButtonComponent, IconComponent, TooltipDirective],
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
  readonly initialHistoryPrefetch = input(true);
  readonly historyError = input("");
  readonly historyRevision = input(0);
  readonly historyRequested = output<ChatHistoryRequest>();
  readonly historyCancelled = output<void>();
  readonly latestRequested = output<void>();
  private readingAnchors: readonly ReadingAnchor[] = [];
  private followingEnd = true;
  private lastFollowingTop = 0;
  private previousFollowTop: number | undefined;
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
  private historyIntent: ChatHistoryRequest = { direction: "before", source: "prefetch" };
  private nativeScrollOrigin: number | undefined;
  onViewportWheel(event: WheelEvent): void {
    if (event.defaultPrevented || event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const viewport = this.viewport().nativeElement;
    // Code, tool output and media can own their own scroll area inside a turn.
    // Only use the wheel for history when it can reach the outer viewport.
    let target = event.target instanceof Element ? event.target : null;
    while (target && target !== viewport) {
      const remaining = target.scrollHeight - target.clientHeight;
      if (remaining > 0) {
        const style = getComputedStyle(target);
        const scrollable = style.overflowY === "auto" || style.overflowY === "scroll";
        const canMove = event.deltaY < 0 ? target.scrollTop > 0 : remaining - target.scrollTop > 1;
        if (scrollable && (canMove || style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none")) return;
      }
      target = target.parentElement;
    }
    this.historyScroll?.prepareWheel(event);
    this.beginHistoryScroll(event.deltaY < 0 ? "before" : "following");
  }
  onViewportPointerDown(event: PointerEvent): void {
    const viewport = this.viewport().nativeElement;
    const gutter = viewport.getBoundingClientRect().left + viewport.clientWidth;
    // A disclosure click must not arm paging. Touch and scrollbar gestures
    // get their direction from the first actual movement of the viewport.
    this.nativeScrollOrigin = undefined;
    if (event.pointerType === "mouse" && event.clientX < gutter) return;
    this.historyScroll?.finish();
    this.nativeScrollOrigin = this.historyScroll?.top ?? viewport.scrollTop;
    this.disclosure = undefined;
    this.interruptSendReveal();
  }
  clearPointerScroll(): void {
    this.nativeScrollOrigin = undefined;
  }
  private beginHistoryScroll(direction: "before" | "following"): void {
    this.nativeScrollOrigin = undefined;
    this.disclosure = undefined;
    this.historyIntent = { direction, source: "reader" };
    if (direction !== this.lastHistoryDirection) this.cancelPendingHistory();
    this.historyBudget = 4;
    this.interruptSendReveal();
    if (direction === 'before' && this.viewport().nativeElement.scrollTop > 0)
      this.followingEnd = false;
    if (this.contentReady) this.scheduleMeasure();
  }

  /** Inline evidence grows below its control, even when the reply was pinned
   * to the end. Its layout is also independent of new-message indicators. */
  keepDisclosurePosition(anchor: HTMLElement): void {
    const turn = anchor.closest('ex-turn');
    if (!this.contentReady || !turn || !this.host.contains(anchor)) return;
    const view = this.viewport().nativeElement.getBoundingClientRect();
    const bounds = anchor.getBoundingClientRect();
    if (bounds.bottom <= view.top || bounds.top >= view.bottom) return;
    this.cancelPendingHistory();
    this.historyBudget = 0;
    if (this.disclosure?.anchor === anchor) this.disclosure.settledFrames = 0;
    else this.disclosure = {
      anchor, turn, settledFrames: 0,
      top: bounds.top - view.top,
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
    if (fresh.length && (this.followingEnd || fresh.some(message => message.revealOnArrival()))) {
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
      this.historyScroll?.finish();
      this.beginHistoryScroll(["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)
        ? "before" : "following");
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
      const prefetch = this.initialHistoryPrefetch();
      if (this.historyIntent.source === "prefetch") this.historyBudget = prefetch ? 4 : 0;
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
        const retained = this.findReadingAnchor();
        if (this.followingEnd && !this.historyAfter()) {
          // A short tail can prefetch older history while still pinned. Its
          // first partial turn may be replaced when its prompt arrives, so no
          // retained DOM anchor can keep the latest reply in place.
          this.historyScroll?.finish();
          viewport.scrollTop = viewport.scrollHeight;
        } else if (retained && this.historyScroll) {
          // Account for native scroll anchoring instead of adding a height delta
          // twice. This also handles removing content at the opposite edge.
          const top = this.historyScroll.top + retained.element.getBoundingClientRect().top - retained.top;
          this.historyScroll.restore(this.paintedScroll, top);
        } else this.historyScroll?.finish();
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
      this.followingEnd = this.startAtEnd();
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
    const viewport = this.viewport().nativeElement;
    const top = this.historyScroll?.top ?? viewport.scrollTop;
    if (this.nativeScrollOrigin !== undefined && top !== this.nativeScrollOrigin)
      this.beginHistoryScroll(top < this.nativeScrollOrigin ? "before" : "following");
    // Layout can move the end after the last bottom write or restore its
    // starting offset. Keep following at either position while reconciling.
    const layoutPending = this.followingEnd && !this.historyAfter() && !this.disclosure &&
      (top === this.previousFollowTop || (top === this.lastFollowingTop &&
        ((this.historyScroll?.height ?? viewport.scrollHeight) !== this.lastScrollHeight ||
          viewport.clientHeight !== this.lastViewportHeight)));
    if (!this.sendScroll && !layoutPending) this.updatePosition();
    this.cancelDistantHistory();
    this.rememberPosition();
    this.rememberReadingAnchor();
    this.scheduleMeasure();
  }
  private updatePosition(): void {
    const viewport = this.viewport().nativeElement;
    const height = this.historyScroll?.height ?? viewport.scrollHeight;
    const top = this.historyScroll?.top ?? viewport.scrollTop;
    const gap = height - top - viewport.clientHeight;
    this.followingEnd = !this.historyAfter() && gap <= 1;
    if (this.followingEnd) this.lastFollowingTop = top;
    else this.previousFollowTop = undefined;
    this.atEnd.set(!this.historyAfter() && gap < 40);
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
    this.revealAnchor(target);
  }

  revealAgentAnchor(target: HTMLElement): void {
    this.disclosure = undefined;
    this.interruptSendReveal();
    this.historyScroll?.finish();
    if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    this.revealAnchor(target);
  }

  private revealAnchor(target: HTMLElement): void {
    const viewport = this.viewport().nativeElement;
    const top = Math.max(0,
      target.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top +
      viewport.scrollTop - 24);
    if (top < viewport.scrollHeight - viewport.clientHeight - 1)
      this.followingEnd = false;
    viewport.scrollTo({
      top,
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
    this.historyIntent = { direction: this.lastHistoryDirection, source: "reader" };
    this.requestHistory(this.historyIntent);
  }
  private rememberReadingAnchor(): void {
    const viewport = this.viewport().nativeElement;
    const view = viewport.getBoundingClientRect();
    if (view.height <= 0) return;
    this.paintedScroll = { top: viewport.scrollTop, height: viewport.scrollHeight };
    const { top, bottom } = view;
    const children = this.content().nativeElement.querySelectorAll("[data-chat-anchor]");
    // The DOM is bounded by the connected owner's transcript window. Keep the
    // first visible stable row, including a reply whose prompt is off screen.
    let low = 0, high = children.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (children[middle]!.getBoundingClientRect().bottom <= top) low = middle + 1;
      else high = middle;
    }
    // A turn may grow above the answer as older work arrives. Anchor the actual
    // visible rows. A reset can fold or evict the first one while its neighbors
    // are still in view.
    const anchors: ReadingAnchor[] = [];
    for (let index = low; index < children.length && anchors.length < 6; index++) {
      const turn = children[index]!;
      const bounds = turn.getBoundingClientRect();
      if (bounds.top >= bottom) break;
      const anchorId = turn.getAttribute('data-chat-anchor');
      for (const row of turn.querySelectorAll('[data-chat-row]')) {
        const rect = row.getBoundingClientRect();
        if (rect.top >= bottom || anchors.length >= 6) break;
        if (rect.height > 0 && rect.bottom > top)
          anchors.push({ element: row, top: rect.top, rowId: row.getAttribute('data-chat-row'), anchorId });
      }
      if (!anchors.some(anchor => anchor.anchorId === anchorId) && bounds.height > 0)
        anchors.push({ element: turn, top: bounds.top, rowId: null, anchorId });
    }
    this.readingAnchors = anchors;
  }
  private findReadingAnchor(): ReadingAnchor | undefined {
    const content = this.content().nativeElement;
    for (const anchor of this.readingAnchors) {
      if (anchor.element.isConnected && anchor.element.getBoundingClientRect().height > 0) return anchor;
      const turn = anchor.anchorId
        ? content.querySelector(`[data-chat-anchor="${CSS.escape(anchor.anchorId)}"]`) : null;
      const selector = anchor.rowId ? `[data-chat-row="${CSS.escape(anchor.rowId)}"]` : null;
      // Hydrating a prompt can change the partial turn's outer identity.
      // Generated summary keys (like the default answer key) belong to a turn.
      const local = anchor.rowId === '$answer' || anchor.element.hasAttribute('data-work-section');
      const element = selector
        ? turn?.querySelector(selector) ?? (local ? null : content.querySelector(selector))
        : turn;
      if (element && element.getBoundingClientRect().height > 0) return { ...anchor, element };
    }
    return undefined;
  }
  private requestHistory(intent: ChatHistoryRequest): void {
    if (this.historyLoading() || this.historyPending) return;
    const { direction } = intent;
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
    if (direction === 'following') {
      this.followingEnd = false;
      this.atEnd.set(false);
    }
    this.historyRequested.emit(intent);
  }
  private cancelDistantHistory(): void {
    if (!this.historyPending || !this.historyLoading() || !this.historyScroll) return;
    const height = this.viewport().nativeElement.clientHeight;
    const { top, height: contentHeight } = this.historyScroll;
    const distance = this.lastHistoryDirection === "before" ? top : contentHeight - top - height;
    // A quick reversal during a held read can put the reader inside the part
    // of the window that the pending page would evict. Allow nearby scrolling.
    if (distance <= height + historyMargin(height)) return;
    this.cancelPendingHistory();
  }
  private cancelPendingHistory(): void {
    if (this.historyPending && this.historyLoading()) {
      this.historyPending = false;
      this.historyBudget = 0;
      this.historyCancelled.emit();
    }
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
    const restored = top === this.previousFollowTop;
    this.previousFollowTop = undefined;
    if (this.sendScroll) this.sendScroll.reconcile();
    else if (!revealing && (resized || contentChanged || restored) && this.followingEnd) {
      this.historyScroll?.finish();
      const from = viewport.scrollTop;
      viewport.scrollTop = viewport.scrollHeight;
      if (viewport.scrollTop !== from) this.previousFollowTop = from;
    } else if (height > this.lastScrollHeight && !revealing) this.unread.set(true);
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
    if (!this.historyError() && !this.sendScroll && !revealing && this.historyBudget > 0 && viewport.clientHeight > 0) {
      // Prefetch before an edge is reached. One owner request remains in flight;
      // successful short pages can keep filling a tall viewport automatically.
      const margin = historyMargin(viewport.clientHeight);
      const underfilled = height <= viewport.clientHeight;
      if (this.historyIntent.direction === "before" && this.historyBefore() && top < margin &&
          (!this.atEnd() || underfilled))
        this.requestHistory(this.historyIntent);
      else if (this.historyIntent.direction === "following" && this.historyAfter() &&
          height - top - viewport.clientHeight < margin)
        this.requestHistory(this.historyIntent);
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
