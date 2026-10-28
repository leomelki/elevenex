import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { StatusGlyphComponent } from "../../ui";
import type { WorkStep } from "../conversation.models";
import { formatDuration, stepVerb } from "./work-summary";
import { StreamTextComponent } from "./stream-text.component";
@Component({
  selector: "ex-now-line",
  imports: [StatusGlyphComponent, StreamTextComponent],
  templateUrl: "./now-line.component.html",
  styleUrl: "./now-line.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NowLineComponent {
  readonly step = input.required<WorkStep>();
  readonly streaming = input(true);
  readonly verb = computed(() => stepVerb(this.step(), true));
  readonly time = computed(() => formatDuration(this.step().elapsed ?? 0));
  readonly progress = computed(() =>
    Math.max(0, Math.min(1, this.step().progress ?? 0)),
  );
}
