import {
  ChangeDetectionStrategy,
  Component,
  input,
  linkedSignal,
} from "@angular/core";

/** A live count rolls once; initial history stays still. Angular owns enter cleanup. */
@Component({
  selector: "ex-ticker",
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./ticker.component.html",
  styleUrl: "./ticker.component.css",
})
export class TickerComponent {
  readonly value = input.required<number>();
  protected readonly display = linkedSignal<
    number,
    { readonly value: number; readonly direction: string }
  >({
    source: this.value,
    computation: (value, previous) => ({
      value,
      direction: previous
        ? value > previous.value.value
          ? "up"
          : value < previous.value.value
            ? "down"
            : ""
        : "",
    }),
  });
}
