import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import { AutoHeightDirective, ButtonComponent } from "../../ui";
import type {
  ToolContentRequest,
  ToolContentSource,
  ToolPresentation,
} from "../tool-presentation";
import { ToolBlockComponent } from "./tool-block.component";

/** A short result first; full evidence and original payloads are read on demand. */
@Component({
  selector: "ex-tool-content",
  imports: [ToolBlockComponent, ButtonComponent, AutoHeightDirective],
  templateUrl: "./tool-content.component.html",
  styleUrl: "./tool-content.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolContentComponent {
  readonly presentation = input.required<ToolPresentation>();
  readonly original = input("");
  readonly fullContent = input<ToolContentSource>();
  readonly contentRequested = output<ToolContentRequest>();
  readonly detailsOpen = signal(false);
  readonly originalOpen = signal(false);
  readonly preview = computed(
    () => this.presentation().preview ?? this.presentation().blocks,
  );
  readonly hasDetails = computed(
    () =>
      this.presentation().preview !== undefined ||
      !!this.original() ||
      !!this.presentation().notice,
  );
  showDetails(event: Event): void {
    const target = event.target;
    if (
      target instanceof HTMLDetailsElement &&
      target.classList.contains("more-details")
    ) {
      this.detailsOpen.set(target.open);
      if (!target.open) this.originalOpen.set(false);
    }
  }
  showOriginal(event: Event): void {
    const target = event.target;
    if (
      target instanceof HTMLDetailsElement &&
      target.classList.contains("raw-details")
    )
      this.originalOpen.set(target.open);
  }
}
