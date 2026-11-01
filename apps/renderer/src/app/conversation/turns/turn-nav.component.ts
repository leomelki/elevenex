import {
  CdkVirtualScrollViewport,
  ScrollingModule,
} from "@angular/cdk/scrolling";
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { TooltipDirective } from "../../ui";
import type { TurnNavigationItem } from "../conversation.models";
@Component({
  selector: "ex-turn-nav",
  imports: [ScrollingModule, TooltipDirective],
  templateUrl: "./turn-nav.component.html",
  styleUrl: "./turn-nav.component.css",
  host: { "[style.--turn-count]": "turns().length" },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TurnNavComponent {
  readonly turns = input<readonly TurnNavigationItem[]>([]);
  readonly active = input("");
  readonly selected = output<string>();
  protected readonly rowHeight = 24;
  protected readonly viewport = viewChild(CdkVirtualScrollViewport);
  protected readonly hovered = signal(false);
  protected readonly focused = signal(false);
  protected readonly above = signal(false);
  protected readonly below = signal(false);
  private readonly prefix = `turns-${crypto.randomUUID()}`;
  private readonly height = signal(0);
  private readonly range = signal({ start: 0, end: 0 });
  private readonly browsed = signal<string | null>(null);
  private readonly browsingOrigin = signal("");
  private readonly count = computed(() => this.turns().length);
  private readonly firstId = computed(() => this.turns()[0]?.id ?? "");
  private readonly indexes = computed(
    () => new Map(this.turns().map((turn, index) => [turn.id, index])),
  );
  private readonly activeIndex = computed(
    () => this.indexes().get(this.active()) ?? 0,
  );
  protected readonly cursor = computed(
    () => this.indexes().get(this.browsed() ?? "") ?? this.activeIndex(),
  );
  protected readonly descendant = computed(() => {
    const index = this.cursor();
    const range = this.range();
    const turn = this.turns()[index];
    return turn && index >= range.start && index < range.end
      ? this.rowId(turn.id)
      : null;
  });
  protected readonly trackTurn = (
    _index: number,
    turn: TurnNavigationItem,
  ): string => turn.id;

  constructor() {
    afterRenderEffect((cleanup) => {
      const viewport = this.viewport();
      if (!viewport) return;
      const resize = new ResizeObserver(() => {
        viewport.checkViewportSize();
        this.height.set(viewport.getViewportSize());
        this.onScroll();
      });
      resize.observe(viewport.elementRef.nativeElement);
      const subscription = viewport.renderedRangeStream.subscribe((range) =>
        this.range.set(range),
      );
      cleanup(() => {
        resize.disconnect();
        subscription.unsubscribe();
      });
    });
    afterRenderEffect(() => {
      const viewport = this.viewport();
      const index = this.activeIndex();
      const height = this.height();
      this.count();
      // Browsing holds its position so streaming and intermediate smooth-scroll
      // events cannot move the targets underneath the user's pointer or focus.
      const browsing =
        (this.hovered() || this.focused()) &&
        this.browsingOrigin() === this.firstId();
      if (viewport && height && !browsing) {
        viewport.scrollToOffset(
          Math.max(0, index * this.rowHeight - (height - this.rowHeight) / 2),
        );
        this.onScroll();
      }
    });
  }

  protected rowId(id: string): string {
    return `${this.prefix}-${encodeURIComponent(id)}`;
  }
  protected label(turn: TurnNavigationItem, index: number): string {
    const state =
      turn.state === "changes"
        ? "Changes to review"
        : turn.state === "attention"
          ? "Needs attention"
          : turn.state === "live"
            ? "Running"
            : "";
    return [
      `Message ${index + 1} of ${this.turns().length}`,
      turn.label || "Message",
      turn.meta,
      state,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  protected onScroll(): void {
    const viewport = this.viewport();
    if (!viewport) return;
    const offset = viewport.measureScrollOffset();
    this.above.set(offset > 1);
    this.below.set(
      offset + viewport.getViewportSize() < this.count() * this.rowHeight - 1,
    );
  }
  protected leave(): void {
    this.hovered.set(false);
    if (!this.focused()) this.browsed.set(null);
  }
  protected enter(): void {
    this.hovered.set(true);
    this.beginBrowsing();
  }
  protected focus(): void {
    this.focused.set(true);
    this.beginBrowsing();
  }
  protected blur(): void {
    this.focused.set(false);
    this.browsed.set(null);
  }
  protected preview(turn: TurnNavigationItem): void {
    this.beginBrowsing();
    this.browsed.set(turn.id);
  }
  private beginBrowsing(): void {
    // Replacing history (or prepending a page) releases a browse held against
    // the old window. Streaming within the same window keeps targets stable.
    this.browsingOrigin.set(this.firstId());
  }
  protected select(turn: TurnNavigationItem): void {
    this.beginBrowsing();
    this.browsed.set(turn.id);
    // Virtual rows may be recycled; focus belongs to the stable viewport.
    this.viewport()?.elementRef.nativeElement.focus({ preventScroll: true });
    this.selected.emit(turn.id);
  }
  protected keydown(event: KeyboardEvent): void {
    const turns = this.turns();
    if (!turns.length) return;
    let index = this.cursor();
    const page = Math.max(1, Math.floor(this.height() / this.rowHeight));
    if (event.key === "ArrowDown") index++;
    else if (event.key === "ArrowUp") index--;
    else if (event.key === "PageDown") index += page;
    else if (event.key === "PageUp") index -= page;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = turns.length - 1;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      const turn = turns[index];
      if (turn) this.select(turn);
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    this.beginBrowsing();
    index = Math.max(0, Math.min(turns.length - 1, index));
    const turn = turns[index];
    const viewport = this.viewport();
    if (!turn || !viewport) return;
    this.browsed.set(turn.id);
    const offset = viewport.measureScrollOffset();
    if (index * this.rowHeight < offset) viewport.scrollToIndex(index);
    else if ((index + 1) * this.rowHeight > offset + this.height())
      viewport.scrollToOffset((index + 1) * this.rowHeight - this.height());
  }
}
