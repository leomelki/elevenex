import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from "@angular/core";
import { IconComponent, FoldComponent, StatusGlyphComponent } from "../../ui";
import type { ToolPresentation } from "../tool-presentation";
import { ToolContentComponent } from "./tool-content.component";
@Component({
  selector: "ex-tool-step",
  imports: [
    IconComponent,
    FoldComponent,
    StatusGlyphComponent,
    ToolContentComponent,
  ],
  templateUrl: "./tool-step.component.html",
  styleUrl: "./tool-step.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolStepComponent {
  readonly icon = input("terminal");
  readonly verb = input("Ran");
  readonly detail = input.required<string>();
  readonly status = input<"running" | "done" | "failed" | "unknown">("done");
  readonly meta = input("");
  readonly output = input("");
  readonly presentation = input<ToolPresentation>();
  readonly hasContent = computed(
    () => !!this.output() || !!this.presentation(),
  );
  readonly open = input(false);
  readonly toggled = signal<boolean | null>(null);
  readonly expanded = computed(() => this.toggled() ?? this.open());
}
