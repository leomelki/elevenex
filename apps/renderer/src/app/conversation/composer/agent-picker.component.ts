import { OverlayModule } from "@angular/cdk/overlay";
import { A11yModule } from "@angular/cdk/a11y";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import { IconComponent, ContextMeterComponent } from "../../ui";
import type {
  AgentConfig,
  AgentHarness,
  ThinkingLevel,
} from "../conversation.models";
@Component({
  selector: "ex-agent-picker",
  imports: [OverlayModule, A11yModule, IconComponent, ContextMeterComponent],
  templateUrl: "./agent-picker.component.html",
  styleUrl: "./picker.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentPickerComponent {
  readonly value = input.required<AgentConfig>();
  readonly harnesses = input<readonly AgentHarness[]>([]);
  readonly locked = input(true);
  readonly changed = output<AgentConfig>();
  readonly fork = output<void>();
  readonly savePreset = output<AgentConfig>();
  readonly open = signal(false);
  readonly currentHarness = computed(() =>
    this.harnesses().find((harness) => harness.id === this.value().harness),
  );
  readonly models = computed(() => this.currentHarness()?.models ?? []);
  readonly thinkingLevels: readonly ThinkingLevel[] = [
    "Off",
    "Low",
    "Medium",
    "High",
    "Max",
  ];
  readonly supportedThinking = computed(
    () =>
      this.models().find((model) => model.id === this.value().model)
        ?.thinking ?? [],
  );
  modelChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const model = event.target.value;
    const selected = this.models().find((item) => item.id === model);
    if (!selected) return;
    const thinking = selected.thinking;
    this.changed.emit({
      ...this.value(),
      preset: undefined,
      model,
      thinking: thinking?.includes(this.value().thinking ?? "Off")
        ? this.value().thinking
        : thinking?.[0],
    });
  }
  thinkingChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const thinking = this.thinkingLevels.find(
      (level) => level === target.value,
    );
    if (thinking && this.supportedThinking().includes(thinking))
      this.changed.emit({ ...this.value(), preset: undefined, thinking });
  }
  harnessChange(event: Event): void {
    const target = event.target;
    if (this.locked() || !(target instanceof HTMLSelectElement)) return;
    const harness = this.harnesses().find((item) => item.id === target.value);
    if (harness)
      this.changed.emit({
        ...this.value(),
        preset: undefined,
        harness: harness.id,
        mark: harness.mark,
        model: harness.models[0]?.id ?? "",
        thinking: harness.models[0]?.thinking[0],
      });
  }
  fastChange(): void {
    this.changed.emit({
      ...this.value(),
      preset: undefined,
      fast: !this.value().fast,
    });
  }
}
