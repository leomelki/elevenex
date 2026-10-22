import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  type ElementRef,
} from "@angular/core";
import { IconComponent } from "../../ui";
interface Reminder {
  readonly id: string;
  readonly text: string;
}
@Component({
  selector: "ex-chat-scroll",
  imports: [IconComponent],
  templateUrl: "./chat-scroll.component.html",
  styleUrl: "./chat-scroll.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatScrollComponent {
  readonly startAtEnd = input(true);
  readonly reminder = input(true);
  readonly activeExchange = output<string>();
  readonly atEnd = signal(true);
  readonly pin = signal<Reminder | null>(null);
  readonly unread = signal(false);
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
    this.destroy.onDestroy(() => this.highlight?.cancel());
    afterNextRender(() => {
      const viewport = this.viewport().nativeElement;
      const content = this.content().nativeElement;
      this.refreshMessages();
      this.atEnd.set(this.startAtEnd());
      if (this.startAtEnd()) viewport.scrollTop = viewport.scrollHeight;
      this.lastScrollHeight = viewport.scrollHeight;
      const resize = new ResizeObserver(() => this.scheduleMeasure());
      resize.observe(content);
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
    const viewport = this.viewport().nativeElement;
    this.atEnd.set(
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40,
    );
    if (this.atEnd()) this.unread.set(false);
    this.scheduleMeasure();
  }
  hideReminder(): void {
    const pin = this.pin();
    if (pin) this.dismissed.add(pin.id);
    this.pin.set(null);
  }
  scrollToMessage(id: string): void {
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
  scrollToEnd(): void {
    const viewport = this.viewport().nativeElement;
    this.atEnd.set(true);
    this.unread.set(false);
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: this.reducedMotion() ? "instant" : "smooth",
    });
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
    if (changed && this.atEnd()) viewport.scrollTop = viewport.scrollHeight;
    else if (changed) this.unread.set(true);
    this.lastScrollHeight = viewport.scrollHeight;
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
