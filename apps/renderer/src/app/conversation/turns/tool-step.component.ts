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
  ToolPresentation,
} from "../tool-presentation";
import { ToolContentComponent } from "./tool-content.component";

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
  readonly active = input(true);
  readonly contentRequested = output<ToolContentRequest>();
  readonly expandedChange = output<boolean>();
  readonly layoutChanging = output<HTMLElement>();
  readonly hasContent = computed(
    () => this.deferred() ? !!this.inspect() : !!this.output() || !!this.presentation(),
  );
  readonly open = input(false);
  readonly toggled = signal<boolean | null>(null);
  readonly expanded = computed(() => this.toggled() ?? this.open());
  protected readonly contentMounted = signal(false);
  protected readonly bodyId = 'tool-evidence-' + crypto.randomUUID();
  private readonly head = viewChild<ElementRef<HTMLButtonElement>>('head');
  private readonly fold = viewChild.required<FoldComponent, ElementRef<HTMLElement>>('fold', { read: ElementRef });
  private readonly source = computed(() => this.deferred(), {
    equal: (left, right) => sameReference(left?.item, right?.item) && sameReference(left?.result, right?.result),
  });
  private readonly inspection = signal<{
    source: SessionChatToolSource; provider: ToolDetailsProvider; value: ToolDetailsInspection;
  } | null>(null);
  protected readonly visible = computed(() => this.active() && this.expanded());
  private readonly current = computed(() => {
    const inspection = this.inspection();
    return this.visible() && inspection && inspection.source === this.source() && inspection.provider === this.inspect()
      ? inspection.value : undefined;
  });
  protected readonly waiting = computed(() => this.current()?.state().status === 'loading');
  private readonly detailView = computed<ToolDetailsState | null>(() => {
    const state = this.current()?.state();
    return state?.status === 'ready' || (state?.status === 'error' && state.reason !== 'unavailable') ? state : null;
  });
  // Keep a live call's evidence in place while its new receipt is read. A
  // different tool or backend provider never inherits the previous contents.
  protected readonly painted = linkedSignal({
    source: () => ({ visible: this.visible(), view: this.detailView(),
      provider: this.inspect(), item: this.source()?.item }),
    computation: (current, previous): ToolDetailsState | null => {
      const last = previous?.value ?? null;
      if (previous && (current.provider !== previous.source.provider ||
          !sameReference(current.item, previous.source.item))) return current.view;
      if (!current.visible) return last;
      return current.view ?? (last?.status === 'ready' ? last : null);
    },
  });
  protected readonly bodyOpen = computed(() => this.visible() &&
    (this.deferred() ? !!this.painted() : this.hasContent()));

  constructor() {
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
    effect(() => {
      const head = this.head()?.nativeElement;
      if (head && this.visible() && this.toggled() && this.painted()) untracked(() => this.layoutChanging.emit(head));
    });
    afterRenderEffect(cleanup => {
      if (this.bodyOpen() || !this.painted()) return;
      const animations = this.fold().nativeElement.getAnimations?.() ?? [];
      if (!animations.length) {
        this.painted.set(null);
        return;
      }
      let closing = true;
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (closing && !this.bodyOpen()) this.painted.set(null);
      });
      cleanup(() => { closing = false; });
    });
  }

  ngOnChanges(): void {
    if (this.open()) this.contentMounted.set(true);
  }
  protected toggle(): void {
    const expanded = !this.expanded();
    const head = this.head()?.nativeElement;
    if (head) this.layoutChanging.emit(head);
    if (expanded) this.contentMounted.set(true);
    this.toggled.set(expanded);
    this.expandedChange.emit(expanded);
  }

  protected retry(): void {
    this.head()?.nativeElement.focus({ preventScroll: true });
    this.current()?.retry();
  }
}
