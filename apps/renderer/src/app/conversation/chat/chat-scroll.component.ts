import {
  afterNextRender,
  afterEveryRender,
  contentChildren,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  type ElementRef,
} from "@angular/core";
import { ButtonComponent, IconComponent, TooltipDirective } from "../../ui";
import { MessageComponent } from "./message.component";
import { ChatSendScroll } from "./chat-send-scroll";
interface Reminder {
  readonly id: string;
  readonly text: string;
}
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
      this.interruptSendReveal();
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
      ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
      this.interruptSendReveal();
  }
  readonly startAtEnd = input(true);
  readonly reminder = input(true);
  readonly activeExchange = output<string>();
  readonly atEnd = signal(true);
  readonly pin = signal<Reminder | null>(null);
  readonly unread = signal(false);
  readonly returnLabel = computed(() =>
    this.unread() ? "New messages. Scroll to bottom" : "Scroll to bottom",
  );
  readonly viewport =
    viewChild.required<ElementRef<HTMLDivElement>>("viewport");
  readonly content = viewChild.required<ElementRef<HTMLDivElement>>("content");
  private readonly destroy = inject(DestroyRef);
  private messages: HTMLElement[] = [];
  private readonly dismissed = new Set<string>();
  private frame: number | null = null;
  private lastActive = "";
  private lastScrollHeight = 0;
  private highlight: Animation | null = null;
  constructor() {
    afterEveryRender(() => {
      this.revealArrivals();
      this.rememberPosition();
    });
    this.destroy.onDestroy(() => {
      this.highlight?.cancel();
      this.sendScroll?.cancel();
      for (const message of this.arrivingMessages) message.finishArrival();
    });
    afterNextRender(() => {
      this.contentReady = true;
      const viewport = this.viewport().nativeElement;
      const content = this.content().nativeElement;
      this.refreshMessages();
      this.atEnd.set(this.startAtEnd());
      if (this.startAtEnd()) viewport.scrollTop = viewport.scrollHeight;
      this.lastScrollHeight = viewport.scrollHeight;
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
    });
  }
  onScroll(): void {
    if (!this.sendScroll) this.updatePosition();
    this.rememberPosition();
    this.scheduleMeasure();
  }
  private updatePosition(): void {
    const viewport = this.viewport().nativeElement;
    this.atEnd.set(
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40,
    );
    if (this.atEnd()) this.unread.set(false);
  }
  hideReminder(): void {
    const pin = this.pin();
    if (pin) this.dismissed.add(pin.id);
    this.pin.set(null);
  }
  scrollToMessage(id: string): void {
    this.interruptSendReveal();
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
    this.interruptSendReveal();
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
    this.scrollToEnd();
  }
  private refreshMessages(): void {
    this.messages = Array.from(
      this.content().nativeElement.querySelectorAll<HTMLElement>(
        "[data-user-message]",
      ),
    );
    const present = new Set(
      this.messages.map((message) => message.dataset["userMessage"] ?? ""),
    );
    for (const id of this.dismissed)
      if (!present.has(id)) this.dismissed.delete(id);
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
    const changed = viewport.scrollHeight !== this.lastScrollHeight;
    if (this.sendScroll) this.sendScroll.reconcile();
    else if (changed && this.atEnd()) viewport.scrollTop = viewport.scrollHeight;
    else if (changed) this.unread.set(true);
    this.lastScrollHeight = viewport.scrollHeight;
    if (!this.sendScroll) this.updatePosition();
    const top = viewport.getBoundingClientRect().top;
    let low = 0;
    let high = this.messages.length - 1;
    let candidate: HTMLElement | undefined;
    // Binary search the ordered prompts; scrolling costs O(log n) layout reads, not a transcript scan.
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const message = this.messages[middle];
      if (message && message.getBoundingClientRect().top < top + 16) {
        candidate = message;
        low = middle + 1;
      } else high = middle - 1;
    }
    const id = candidate?.dataset["userMessage"] ?? "";
    if (id !== this.lastActive) {
      this.lastActive = id;
      this.activeExchange.emit(id);
    }
    const shouldPin =
      this.reminder() &&
      candidate &&
      candidate.getBoundingClientRect().bottom < top &&
      !this.dismissed.has(id);
    this.rememberPosition();
    this.pin.set(
      shouldPin && candidate
        ? {
            id,
            text:
              candidate.querySelector(".content")?.textContent?.trim() ??
              candidate.textContent?.trim() ??
              "",
          }
        : null,
    );
  }
  private reducedMotion(): boolean {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
}
