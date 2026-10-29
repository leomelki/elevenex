import { OverlayModule } from "@angular/cdk/overlay";
import { A11yModule } from "@angular/cdk/a11y";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  afterRenderEffect,
  input,
  output,
  signal,
  viewChild,
  ElementRef,
} from "@angular/core";
import {
  AutoHeightDirective,
  IconComponent,
  ContextMeterComponent,
  DropdownComponent,
  SwitchComponent,
} from "../../ui";
import type { AgentConfig, AgentHarness } from "../conversation.models";
@Component({
  selector: "ex-agent-picker",
  imports: [
    OverlayModule,
    A11yModule,
    IconComponent,
    ContextMeterComponent,
    DropdownComponent,
    SwitchComponent,
    AutoHeightDirective,
  ],
  templateUrl: "./agent-picker.component.html",
  styleUrl: "./picker.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentPickerComponent {
  readonly value = input.required<AgentConfig>();
  readonly harnesses = input<readonly AgentHarness[]>([]);
  readonly locked = input(true);
  readonly disabled = input(false);
  readonly busy = input(false);
  readonly showFork = input(true);
  readonly showSavePreset = input(true);
  readonly reasoningAvailable = input(true);
  readonly fastAvailable = input(true);
  readonly changed = output<AgentConfig>();
  readonly fork = output<void>();
  readonly savePreset = output<AgentConfig>();
  readonly open = signal(false);
  private readonly dialog = viewChild<ElementRef<HTMLElement>>("dialog");
  readonly currentHarness = computed(() =>
    this.harnesses().find((harness) => harness.id === this.value().harness),
  );
  readonly models = computed(() => this.currentHarness()?.models ?? []);
  readonly selectedModel = computed(() =>
    this.models().find((model) => model.id === this.value().model),
  );
  readonly modelLabel = computed(
    () =>
      this.selectedModel()?.label || this.value().model || "Provider default",
  );
  readonly supportedThinking = computed(
    () => this.selectedModel()?.thinking ?? [],
  );
  readonly thinkingOptions = computed(() => {
    const supported = this.supportedThinking();
    const levels = supported.some((level) => level === level.toLowerCase())
      ? ["low", "medium", "high", "xhigh", "max"]
      : ["Off", "Low", "Medium", "High", "Max"];
    return [
      { id: "", label: "Provider default" },
      ...[...new Set([...levels, ...supported])].map((id) => ({
        id,
        label: this.thinkingLabel(id),
        disabled: !supported.includes(id),
      })),
    ];
  });
  thinkingLabel(value: string): string {
    return value === "xhigh"
      ? "Extra high"
      : value
        ? value.charAt(0).toUpperCase() + value.slice(1)
        : "";
  }

  constructor() {
    afterRenderEffect(() => {
      if (this.disabled()) this.open.set(false);
    });
  }
  openPicker(): void {
    if (!this.disabled()) this.open.set(true);
  }
  overlayKey(event: KeyboardEvent): void {
    // Nested CDK menus own their first Escape. Their portaled targets are
    // outside this dialog even though the overlay dispatcher also notifies us.
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      event.target instanceof Node &&
      this.dialog()?.nativeElement.contains(event.target)
    ) {
      event.stopPropagation();
      this.open.set(false);
    }
  }
  modelChange(model: string): void {
    if (this.disabled() || this.busy()) return;
    const selected = this.models().find((item) => item.id === model);
    if (!selected) return;
    const thinking = selected.thinking;
    this.changed.emit({
      ...this.value(),
      preset: undefined,
      model,
      thinking: thinking?.includes(this.value().thinking ?? "")
        ? this.value().thinking
        : thinking?.[0],
    });
  }
  thinkingChange(thinking: string): void {
    if (
      !this.disabled() &&
      !this.busy() &&
      this.reasoningAvailable() &&
      (!thinking || this.supportedThinking().includes(thinking))
    )
      this.changed.emit({
        ...this.value(),
        preset: undefined,
        thinking: thinking || undefined,
      });
  }
  harnessChange(id: string): void {
    if (this.locked() || this.disabled() || this.busy()) return;
    const harness = this.harnesses().find((item) => item.id === id);
    if (harness) {
      this.changed.emit({
        ...this.value(),
        preset: undefined,
        harness: harness.id,
        mark: harness.mark,
        model: harness.models[0]?.id ?? "",
        thinking: harness.models[0]?.thinking[0],
      });
      this.open.set(false);
    }
  }
  fastChange(): void {
    if (this.disabled() || this.busy() || !this.fastAvailable()) return;
    this.changed.emit({
      ...this.value(),
      preset: undefined,
      fast: !this.value().fast,
    });
  }
}
