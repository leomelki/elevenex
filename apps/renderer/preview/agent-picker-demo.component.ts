import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import {
  AgentPickerComponent,
  type AgentConfig,
  type AgentHarness,
} from "../src/app/conversation";
import { ButtonComponent } from "../src/app/ui";

/** Reference-shaped specimens; no fixtures enter the product import graph. */
@Component({
  selector: "ex-agent-picker-demo",
  imports: [AgentPickerComponent, ButtonComponent],
  templateUrl: "./agent-picker-demo.component.html",
  styleUrl: "./agent-picker-demo.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentPickerDemoComponent {
  readonly agent = signal<AgentConfig>({
    preset: "Deep work",
    mark: "Cl",
    harness: "claude",
    model: "opus",
    thinking: "High",
  });
  readonly locked = signal(true);
  readonly busy = signal(false);
  readonly disabled = signal(false);
  readonly notice = signal("");
  readonly harnesses: readonly AgentHarness[] = [
    {
      id: "claude",
      label: "Claude Code",
      mark: "Cl",
      models: [
        {
          id: "opus",
          label: "Opus 5.5",
          thinking: ["Off", "Low", "Medium", "High", "Max"],
          supportsFastMode: true,
        },
        {
          id: "sonnet",
          label: "Sonnet 5.5",
          thinking: ["Low", "Medium", "High"],
          supportsFastMode: true,
        },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      mark: "Cx",
      models: [
        {
          id: "codex",
          label: "GPT-5 Codex",
          thinking: ["Low", "Medium", "High", "Max"],
          supportsFastMode: true,
        },
      ],
    },
    {
      id: "local",
      label: "Local",
      mark: "Lo",
      models: [{ id: "qwen", label: "Qwen3 Coder", thinking: ["Off"] }],
    },
  ];
  usage(enabled: boolean): void {
    this.agent.update((agent) => ({
      ...agent,
      context: enabled ? 0.84 : undefined,
      tokens: enabled ? "168k of 200k" : undefined,
      plan: enabled
        ? {
            name: "Claude plan",
            tier: "Max",
            win: 0.12,
            week: 0.58,
            resetWin: "14:30",
            resetWeek: "Monday",
          }
        : undefined,
    }));
  }
  compact(): void {
    this.agent.update((agent) => ({
      ...agent,
      context: 0.38,
      tokens: "76k of 200k",
    }));
    this.notice.set("Context compacted in preview");
  }
  save(agent: AgentConfig): void {
    this.agent.set({ ...agent, preset: "Saved mix" });
    this.notice.set("Preset saved in preview");
  }
}
