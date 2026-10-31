import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import {
  ButtonComponent,
  DropdownComponent,
  IconComponent,
  SegmentedComponent,
  SwitchComponent,
  type SegmentOption,
} from "../../ui";
import type { AgentConfig, AgentHarness } from "../conversation.models";

import { AgentMarkComponent } from "./agent-mark.component";

/** Controlled settings; provider mutations and popover lifetime belong to the owner. */
@Component({
  selector: "ex-agent-settings",
  imports: [
    AgentMarkComponent,
    ButtonComponent,
    DropdownComponent,
    IconComponent,
    SegmentedComponent,
    SwitchComponent,
  ],
  templateUrl: "./agent-settings.component.html",
  styleUrl: "./agent-settings.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentSettingsComponent {
  readonly draftMode = input(false);
  readonly value = input.required<AgentConfig>();
  readonly harnesses = input<readonly AgentHarness[]>([]);
  readonly harnessAppearance = input<"segmented" | "dropdown">("segmented");
  readonly modelBusy = input(false);
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
  protected readonly unavailable = computed(
    () => this.disabled() || this.busy(),
  );
  protected readonly modelUnavailable = computed(
    () => this.unavailable() || this.modelBusy(),
  );
  protected readonly harness = computed(() =>
    this.harnesses().find((harness) => harness.id === this.value().harness),
  );
  protected readonly models = computed(() => this.harness()?.models ?? []);
  protected readonly harnessOptions = computed<readonly SegmentOption[]>(() =>
    this.harnesses().map((harness) => ({
      id: harness.id,
      label: harness.label,
      disabled: this.unavailable(),
    })),
  );
  protected readonly thinkingOptions = computed<readonly SegmentOption[]>(
    () => {
      const supported =
        this.models().find((model) => model.id === this.value().model)
          ?.thinking ?? [];
      const lowercase = supported.some(
        (level) => level === level.toLowerCase(),
      );
      const standard = ["Off", "Low", "Medium", "High", "Max"].map((label) => {
        const id =
          supported.find(
            (level) => level.toLowerCase() === label.toLowerCase(),
          ) ??
          (label === "Off" && supported.includes("none")
            ? "none"
            : lowercase
              ? label.toLowerCase()
              : label);
        return {
          id,
          label: label === "Medium" ? "Med" : label,
          title: label,
          disabled: this.modelUnavailable() || !supported.includes(id),
        };
      });
      const known = new Set(standard.map((level) => level.id));
      return [
        ...standard,
        ...supported
          .filter((id) => !known.has(id))
          .map((id) => ({
            id,
            label:
              id === "xhigh"
                ? "XHigh"
                : id.charAt(0).toUpperCase() + id.slice(1),
            title: id === "xhigh" ? "Extra high" : id,
            disabled: this.modelUnavailable(),
          })),
      ];
    },
  );
  modelChange(model: string): void {
    if (this.modelUnavailable() || model === this.value().model) return;
    const selected = this.models().find((item) => item.id === model);
    if (!selected) return;
    this.changed.emit({
      ...this.value(),
      preset: undefined,
      model,
      thinking: selected.thinking.includes(this.value().thinking ?? "")
        ? this.value().thinking
        : selected.thinking[0],
    });
  }
  thinkingChange(thinking: string): void {
    if (
      this.modelUnavailable() ||
      !this.reasoningAvailable() ||
      !this.thinkingOptions().some(
        (option) => option.id === thinking && !option.disabled,
      ) ||
      thinking === this.value().thinking
    )
      return;
    this.changed.emit({ ...this.value(), preset: undefined, thinking });
  }
  harnessChange(id: string): void {
    if (this.locked() || this.unavailable() || id === this.value().harness)
      return;
    const harness = this.harnesses().find((item) => item.id === id);
    if (harness)
      this.changed.emit({
        ...this.value(),
        preset: undefined,
        harness: id,
        mark: harness.mark,
        model: harness.models[0]?.id ?? "",
        thinking: harness.models[0]?.thinking[0],
        fast: false,
        context: undefined,
        tokens: undefined,
        plan: undefined,
      });
  }
  fastChange(fast: boolean): void {
    if (!this.modelUnavailable() && this.fastAvailable())
      this.changed.emit({ ...this.value(), preset: undefined, fast });
  }
}
