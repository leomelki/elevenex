import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from "@angular/core";
import { IconComponent, FoldComponent, StatusGlyphComponent } from "../../ui";
@Component({
  selector: "ex-tool-step",
  imports: [IconComponent, FoldComponent, StatusGlyphComponent],
  templateUrl: "./tool-step.component.html",
  styleUrl: "./tool-step.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolStepComponent {
  readonly icon = input("terminal");
  readonly verb = input("Ran");
  readonly detail = input.required<string>();
  readonly status = input<"running" | "done" | "failed">("done");
  readonly meta = input("");
  readonly output = input("");
  readonly open = input(false);
  readonly toggled = signal<boolean | null>(null);
  readonly expanded = computed(() => this.toggled() ?? this.open());
}
