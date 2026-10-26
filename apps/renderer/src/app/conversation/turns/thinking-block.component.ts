import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from "@angular/core";
import { FoldComponent, IconComponent } from "../../ui";
import { formatDuration } from "./work-summary";
@Component({
  selector: "ex-thinking-block",
  imports: [FoldComponent, IconComponent],
  template: `@if (seconds() >= 1) {
    <button
      type="button"
      [attr.aria-expanded]="expanded()"
      (click)="toggled.set(!expanded())"
    >
      <ex-icon
        [name]="expanded() ? 'chevron-down' : 'chevron-right'"
        [size]="12"
      /><span [class.active]="active()">{{
        active() ? "Thinking" : "Thought for"
      }}</span
      ><span>{{ duration() }}</span></button
    ><ex-fold [open]="expanded()"
      ><div class="reasoning"><ng-content /></div
    ></ex-fold>
  }`,
  styleUrl: "./thinking-block.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThinkingBlockComponent {
  readonly active = input(false);
  readonly seconds = input(0);
  readonly open = input(false);
  readonly toggled = signal<boolean | null>(null);
  readonly expanded = computed(() => this.toggled() ?? this.open());
  readonly duration = computed(() => formatDuration(this.seconds()));
}
