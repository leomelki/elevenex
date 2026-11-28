import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
  type OnChanges,
} from "@angular/core";
import type { SessionChatToolReference, SessionChatToolSource } from "@elevenex/shared";
import { AutoHeightDirective, ButtonComponent, IconComponent, FoldComponent, StatusGlyphComponent } from "../../ui";
import type {
  ToolContentRequest,
  ToolContentSource,
  ToolDetailsInspection,
  ToolDetailsProvider,
  ToolDetailsState,
  ToolImage,
  ToolImageProvider,
  ToolImageResolver,
  ToolPresentation,
} from "../tool-presentation";
import { MarkdownMediaComponent } from '../markdown/markdown-media.component';
import { ToolContentComponent } from "./tool-content.component";

// Resting on a tool heading is deliberate; scanning a list passes each row faster.
const TOOL_INTENT_MS = 100;
const TOOL_PENDING_CUE_MS = 120;

function sameReference(left?: SessionChatToolReference, right?: SessionChatToolReference): boolean {
  return left?.id === right?.id && left?.revision === right?.revision;
}

@Component({
  selector: "ex-tool-step",
  imports: [
    AutoHeightDirective,
    ButtonComponent,
    IconComponent,
    FoldComponent,
    StatusGlyphComponent,
    MarkdownMediaComponent,
    ToolContentComponent,
  ],
  templateUrl: "./tool-step.component.html",
  styleUrl: "./tool-step.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolStepComponent implements OnChanges {
  readonly icon = input("terminal");
  readonly verb = input("Ran");
  readonly detail = input.required<string>();
  readonly detailTruncation = input<"start" | "end">("end");
  readonly status = input<"running" | "done" | "failed" | "unknown">("done");
  readonly meta = input("");
  readonly output = input("");
  readonly presentation = input<ToolPresentation>();
  readonly fullContent = input<ToolContentSource>();
  readonly deferred = input<SessionChatToolSource>();
  readonly inspect = input<ToolDetailsProvider>();
  readonly images = input<readonly ToolImage[]>();
  readonly inspectImages = input<ToolImageProvider>();
  readonly active = input(true);
  readonly contentRequested = output<ToolContentRequest>();
  readonly openFile = output<string>();
  readonly copiedCode = input<string | null>(null);
  readonly copyCode = output<string>();
  readonly expandedChange = output<boolean>();
  readonly layoutChanging = output<HTMLElement>();
  readonly hasContent = computed(
    () => (!!this.images()?.length && !!this.inspectImages()) ||
      (this.deferred() ? !!this.inspect() : !!this.output() || !!this.presentation()),
  );
  readonly open = input(false);
  readonly toggled = signal<boolean | null>(null);
  readonly expanded = computed(() => this.toggled() ?? this.open());
  protected readonly contentMounted = signal(false);
  protected readonly bodyId = 'tool-evidence-' + crypto.randomUUID();
  private readonly head = viewChild<ElementRef<HTMLButtonElement>>('head');
  private readonly fold = viewChild.required<FoldComponent, ElementRef<HTMLElement>>('fold', { read: ElementRef });
  private readonly source = computed(() => this.deferred(), {
    equal: (left, right) => left?.turnId === right?.turnId && sameReference(left?.item, right?.item) && sameReference(left?.result, right?.result),
  });
  private readonly inspection = signal<{
    source: SessionChatToolSource; provider: ToolDetailsProvider; value: ToolDetailsInspection;
  } | null>(null);
  protected readonly visible = computed(() => this.active() && this.expanded());
  protected readonly imagePanel = linkedSignal({
    source: () => ({ visible: this.visible(), images: this.images(), provider: this.inspectImages() }),
    computation: ({ visible, images, provider }, previous): { images: readonly ToolImage[]; provider: ToolImageProvider } | null => {
      if (!images?.length || !provider) return null;
      const last = previous?.value;
      if (last?.images === images && last.provider === provider) return last;
      return visible ? { images, provider } : null;
    },
  });
  protected readonly imageAssets = signal<ToolImageResolver | undefined>(undefined);
  private readonly current = computed(() => {
    const inspection = this.inspection();
    return this.visible() && inspection && inspection.source === this.source() && inspection.provider === this.inspect()
      ? inspection.value : undefined;
  });
  protected readonly waiting = computed(() => this.current()?.state().status === 'loading');
  /** A read that outlasts an instant-feeling interval shows a cue on the heading. */
  protected readonly pending = signal(false);
  private readonly intent = signal<'dwell' | 'press' | null>(null);
  private readonly detailView = computed<ToolDetailsState | null>(() => {
    const state = this.current()?.state();
    return state?.status === 'ready' || (state?.status === 'error' && state.reason !== 'unavailable') ? state : null;
  });
  // Keep a live call's evidence in place while its new receipt is read. A
  // different tool or backend provider never inherits the previous contents.
  protected readonly painted = linkedSignal({
    source: () => ({ visible: this.visible(), view: this.detailView(),
      provider: this.inspect(), item: this.source()?.item, turnId: this.source()?.turnId }),
    computation: (current, previous): ToolDetailsState | null => {
      const last = previous?.value ?? null;
      if (previous && (current.provider !== previous.source.provider || current.turnId !== previous.source.turnId ||
          !sameReference(current.item, previous.source.item))) return current.view;
      if (!current.visible) return last;
      return current.view ?? (last?.status === 'ready' ? last : null);
    },
  });
  protected readonly bodyOpen = computed(() => this.visible() &&
    (!!this.imagePanel() || (this.deferred() ? !!this.painted() : this.hasContent())));

  constructor() {
    effect(cleanup => {
      const intent = this.intent(), source = this.source(), prefetch = this.inspect()?.prefetch;
      if (!intent || !source || !prefetch || this.expanded()) return;
      if (intent === 'press') {
        untracked(() => prefetch(source));
        return;
      }
      const timer = setTimeout(() => prefetch(source), TOOL_INTENT_MS);
      cleanup(() => clearTimeout(timer));
    });
    effect(cleanup => {
      if (!this.waiting()) {
        this.pending.set(false);
        return;
      }
      const timer = setTimeout(() => this.pending.set(true), TOOL_PENDING_CUE_MS);
      cleanup(() => clearTimeout(timer));
    });
    effect(cleanup => {
      const source = this.source(), provider = this.inspect();
      if (!source || !provider || !this.visible()) {
        this.inspection.set(null);
        return;
      }
      const abort = new AbortController();
      const value = untracked(() => provider(source, abort.signal));
      this.inspection.set({ source, provider, value });
      cleanup(() => abort.abort());
    });
    effect(cleanup => {
      const panel = this.imagePanel();
      if (!panel) {
        this.imageAssets.set(undefined);
        return;
      }
      const abort = new AbortController();
      this.imageAssets.set(untracked(() => panel.provider(panel.images, abort.signal)));
      cleanup(() => abort.abort());
    });
    effect(() => {
      const head = this.head()?.nativeElement;
      if (head && this.visible() && this.toggled() && this.painted()) untracked(() => this.layoutChanging.emit(head));
    });
    afterRenderEffect(cleanup => {
      if (this.bodyOpen() || (!this.painted() && !this.imagePanel())) return;
      const clear = () => {
        this.painted.set(null);
        this.imagePanel.set(null);
      };
      const animations = this.fold().nativeElement.getAnimations?.() ?? [];
      if (!animations.length) {
        clear();
        return;
      }
      let closing = true;
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (closing && !this.bodyOpen()) clear();
      });
      cleanup(() => { closing = false; });
    });
  }

  ngOnChanges(): void {
    if (this.open()) this.contentMounted.set(true);
  }
  protected hover(event: PointerEvent, inside: boolean): void {
    if (event.pointerType !== 'mouse') return;
    if (!inside) this.intent.set(null);
    else if (!this.intent()) this.intent.set('dwell');
  }

  protected focusHead(focused: boolean): void {
    if (!focused) this.intent.set(null);
    else if (!this.intent() && this.head()?.nativeElement.matches(':focus-visible')) this.intent.set('dwell');
  }

  /** Start reading on press rather than release. A touch press may begin a scroll. */
  protected press(event: PointerEvent | KeyboardEvent): void {
    if (event instanceof KeyboardEvent
      ? !event.repeat && (event.key === 'Enter' || event.key === ' ')
      : event.pointerType !== 'touch' && event.button === 0) this.intent.set('press');
  }

  protected toggle(): void {
    const expanded = !this.expanded();
    const head = this.head()?.nativeElement;
    if (head) this.layoutChanging.emit(head);
    if (expanded) this.contentMounted.set(true);
    // A fresh hover or press warms a closed tool again.
    else this.intent.set(null);
    this.toggled.set(expanded);
    this.expandedChange.emit(expanded);
  }

  protected retry(): void {
    this.head()?.nativeElement.focus({ preventScroll: true });
    this.current()?.retry();
  }
}
