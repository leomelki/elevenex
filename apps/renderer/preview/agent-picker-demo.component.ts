import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from "@angular/core";
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
          thinking: ["Low", "Medium", "High", "xhigh", "Max"],
          supportsFastMode: true,
        },
        {
          id: "sonnet",
          label: "Sonnet 5.5",
          thinking: ["Low", "Medium", "High"],
          supportsFastMode: true,
        },
        { id: "haiku", label: "Haiku 5.5", thinking: ["Low", "Medium"] },
        { id: "fable", label: "Fable 5.1", thinking: ["Low", "Medium", "High"] },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      mark: "Cx",
      models: [
        {
          id: "codex",
          label: "GPT-5.5 Codex",
          thinking: ["minimal", "low", "medium", "high", "xhigh"],
          supportsFastMode: true,
        },
        {
          id: "gpt",
          label: "GPT-5.5",
          thinking: ["minimal", "low", "medium", "high"],
        },
        {
          id: "codex-mini",
          label: "GPT-5.5 Codex Mini",
          thinking: ["low", "medium", "high"],
        },
      ],
    },
    {
      id: "pi",
      label: "Pi",
      mark: "Pi",
      models: [
        {
          id: "pi-sonnet",
          label: "Claude Sonnet 5.5",
          thinking: ["off", "minimal", "low", "medium", "high"],
        },
        { id: "pi-gpt", label: "GPT-5.5", thinking: ["off", "low", "high"] },
      ],
    },
    {
      id: "opencode",
      label: "OpenCode",
      mark: "Oc",
      models: [
        ...[
          "Claude Opus 5.5",
          "Claude Sonnet 5.5",
          "Claude Haiku 5.5",
          "GPT-5.5",
          "GPT-5.5 Codex",
          "Gemini 3 Pro",
          "Gemini 3 Flash",
          "Grok Code Fast",
          "Kimi K3",
          "Qwen3 Coder",
          "DeepSeek V4",
          "GLM 5",
        ].map((label) => ({
          id: label.toLowerCase().replaceAll(" ", "-"),
          label,
          thinking: ["low", "medium", "high"],
        })),
      ],
    },
    {
      id: "local",
      label: "Local runner",
      mark: "Lo",
      models: [{ id: "qwen", label: "Qwen3 Coder", thinking: [] }],
    },
  ];
  /** As in a connected session: fast mode follows the chosen model's support. */
  readonly fastAvailable = computed(
    () =>
      !!this.agent().fast ||
      !!this.harnesses
        .find((harness) => harness.id === this.agent().harness)
        ?.models.find((model) => model.id === this.agent().model)
        ?.supportsFastMode,
  );
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
