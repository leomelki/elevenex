import { NgTemplateOutlet } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  linkedSignal,
  output,
} from "@angular/core";
import {
  ButtonComponent,
  FittedHighlightDirective,
  IconComponent,
  SkeletonComponent,
  TooltipDirective,
} from "../../ui";
import type {
  AgentConfig,
  AgentHarness,
  AgentModel,
} from "../conversation.models";
import { withHarness, withModel } from "./agent-config";
import { AgentMarkComponent } from "./agent-mark.component";
import { limitingPlan, resetLabel, usagePercent } from "./agent-usage";
import { ThinkingSliderComponent } from "./thinking-slider.component";

/** Lists longer than this get a filter field; shorter ones use type-ahead. */
const FILTER_FROM = 8;

/**
 * The composer's agent menu: harnesses as a rail of logos (while the harness can
 * still change), the harness's models as a list, then thinking and fast mode.
 * Controlled: it emits config intents; the picker owns its surface and focus.
 */
@Component({
  selector: "ex-agent-menu",
  imports: [
    AgentMarkComponent,
    ButtonComponent,
    FittedHighlightDirective,
    IconComponent,
    NgTemplateOutlet,
    SkeletonComponent,
    ThinkingSliderComponent,
    TooltipDirective,
  ],
  templateUrl: "./agent-menu.component.html",
  styleUrl: "./agent-menu.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.with-rail]": "showRail()",
    "[attr.aria-busy]": "busy()",
  },
})
export class AgentMenuComponent {
  readonly value = input.required<AgentConfig>();
  readonly harnesses = input<readonly AgentHarness[]>([]);
  readonly locked = input(true);
  /** Closed or blocked: every control is disabled. */
  readonly disabled = input(false);
  /** An update is applying: choices stay focusable but take no input. */
  readonly busy = input(false);
  readonly showFork = input(true);
  readonly showSavePreset = input(true);
  readonly reasoningAvailable = input(true);
  readonly fastAvailable = input(true);
  readonly canCompact = input(false);
  readonly changed = output<AgentConfig>();
  readonly fork = output<void>();
  readonly savePreset = output<AgentConfig>();
  readonly compactRequested = output<void>();

  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly harness = computed(() =>
    this.harnesses().find((harness) => harness.id === this.value().harness),
  );
  protected readonly harnessLabel = computed(
    () =>
      this.harness()?.label || this.value().harnessLabel || this.value().harness,
  );
  protected readonly showRail = computed(
    () => !this.locked() && this.harnesses().length > 1,
  );
  protected readonly models = computed(() => this.harness()?.models ?? []);
  /** Memoized so a new config for the same harness keeps the filter. */
  private readonly harnessId = computed(() => this.value().harness);
  /** Once offered, search stays mounted for this harness until the menu closes.
   * Catalog refreshes must not remove a focused field or hide an active query. */
  protected readonly filterable = linkedSignal({
    source: () => ({ harness: this.harnessId(), count: this.models().length }),
    computation: ({ harness, count }, previous): boolean =>
      count > FILTER_FROM ||
      (previous?.source.harness === harness && previous.value),
  });
  /** A filter belongs to one harness's list. */
  protected readonly query = linkedSignal({
    source: this.harnessId,
    computation: () => "",
  });
  protected readonly visible = computed(() => {
    const query = this.query().trim().toLowerCase();
    return query
      ? this.models().filter((model) =>
          `${model.label} ${model.id}`.toLowerCase().includes(query),
        )
      : this.models();
  });
  protected readonly selectedModel = computed(() =>
    this.models().find((model) => model.id === this.value().model),
  );
  /** Focus lands on the chosen model; while busy, on the stable heading. */
  protected readonly initialModel = computed(() =>
    this.disabled() || this.busy()
      ? undefined
      : this.visible().find((model) => model.id === this.value().model)?.id,
  );
  protected readonly tabbableModel = computed(
    () =>
      this.visible().find((model) => model.id === this.value().model)?.id ??
      this.visible()[0]?.id,
  );
  protected readonly levels = computed(() =>
    this.reasoningAvailable() ? [...new Set(this.selectedModel()?.thinking)] : [],
  );
  protected readonly plan = computed(() => {
    const plan = this.value().plan;
    if (!plan) return undefined;
    const limit = limitingPlan(plan);
    const reset = limit.reset ? resetLabel(limit.reset) : "";
    return {
      text:
        limit.left <= 0
          ? `Used up${limit.resetShort || limit.reset ? " · " + (limit.resetShort || limit.reset) : ""}`
          : `${usagePercent(limit.left)} left`,
      tone: limit.left <= 0 ? "danger" : limit.left <= 0.2 ? "attention" : "normal",
      detail: [
        [plan.name || "Plan", plan.tier].filter(Boolean).join(" "),
        `${limit.label}: ${limit.left <= 0 ? "used up" : usagePercent(limit.left) + " left"}`,
        reset,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
  /** Compacting is offered only once context is filling up. */
  protected readonly contextNotice = computed(() => {
    const context = this.value().context;
    return this.canCompact() && context !== undefined && context >= 0.75
      ? {
          percent: usagePercent(context),
          tone: context >= 0.9 ? "danger" : "attention",
        }
      : undefined;
  });
  protected readonly showSave = computed(
    () => this.showSavePreset() && !this.value().preset,
  );
  protected readonly showForkAction = computed(
    () => this.locked() && this.showFork(),
  );

  protected harnessChange(id: string): void {
    if (this.locked() || this.disabled() || this.busy()) return;
    const harness = this.harnesses().find((item) => item.id === id);
    if (harness && id !== this.value().harness)
      this.changed.emit(withHarness(this.value(), harness));
  }
  protected modelChange(model: AgentModel): void {
    if (this.disabled() || this.busy() || model.id === this.value().model)
      return;
    this.changed.emit(withModel(this.value(), model));
  }
  protected thinkingChange(thinking: string): void {
    if (this.disabled() || this.busy() || !this.levels().includes(thinking))
      return;
    this.changed.emit({ ...this.value(), preset: undefined, thinking });
  }
  protected fastToggle(): void {
    if (this.disabled() || this.busy() || !this.fastAvailable()) return;
    this.changed.emit({
      ...this.value(),
      preset: undefined,
      fast: !this.value().fast,
    });
  }
  protected filter(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
  protected compact(): void {
    // A successful compaction removes its button: keep focus on stable content.
    this.host.querySelector<HTMLElement>(".heading")?.focus();
    this.compactRequested.emit();
  }

  /** Arrow keys move and select, as in any radio group. */
  protected railKey(event: KeyboardEvent, index: number): void {
    const harnesses = this.harnesses();
    const next = this.step(event, index, harnesses.length);
    if (next === undefined) return;
    event.preventDefault();
    const harness = harnesses[next];
    if (!harness) return;
    this.buttons(".agent")[next]?.focus();
    this.harnessChange(harness.id);
  }
  /** Arrow keys move focus only: choosing a model is a deliberate ↵ or click. */
  protected listKey(event: KeyboardEvent, index: number): void {
    const options = this.buttons(".model");
    const next = this.step(event, index, options.length, false);
    if (next !== undefined) {
      event.preventDefault();
      options[next]?.focus();
      return;
    }
    if (
      event.key === " " ||
      event.key.length !== 1 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    if (this.filterable()) {
      event.preventDefault();
      this.query.set(this.query() + event.key);
      this.host.querySelector<HTMLInputElement>(".filter input")?.focus();
      return;
    }
    const key = event.key.toLowerCase();
    const models = this.visible();
    for (let offset = 1; offset <= models.length; offset++) {
      const at = (index + offset) % models.length;
      if (models[at]?.label.toLowerCase().startsWith(key)) {
        event.preventDefault();
        options[at]?.focus();
        return;
      }
    }
  }
  protected filterKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.buttons(".model")[0]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const first = this.visible()[0];
      if (first) this.modelChange(first);
    } else if (event.key === "Escape" && this.query()) {
      // The first Escape clears the filter; the next one closes the menu.
      event.preventDefault();
      event.stopPropagation();
      this.query.set("");
    }
  }

  private buttons(selector: string): HTMLButtonElement[] {
    return [...this.host.querySelectorAll<HTMLButtonElement>(selector)];
  }
  private step(
    event: KeyboardEvent,
    index: number,
    length: number,
    wrap = true,
  ): number | undefined {
    if (!length) return undefined;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        return wrap ? (index + 1) % length : Math.min(length - 1, index + 1);
      case "ArrowUp":
      case "ArrowLeft":
        return wrap ? (index - 1 + length) % length : Math.max(0, index - 1);
      case "Home":
        return 0;
      case "End":
        return length - 1;
      default:
        return undefined;
    }
  }
}
