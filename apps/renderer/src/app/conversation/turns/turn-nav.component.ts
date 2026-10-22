import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import type { TurnNavigationItem } from "../conversation.models";
@Component({
  selector: "ex-turn-nav",
  template: `@if (turns().length >= 5) {
    <nav aria-label="Conversation turns">
      @for (turn of turns(); track turn.id) {
        <button
          type="button"
          [attr.data-state]="turn.state"
          [attr.aria-current]="active() === turn.id ? 'step' : null"
          [title]="turn.label + (turn.meta ? ' · ' + turn.meta : '')"
          [attr.aria-label]="turn.label"
          (click)="selected.emit(turn.id)"
        >
          <span></span>
        </button>
      }
    </nav>
  }`,
  styleUrl: "./turn-nav.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TurnNavComponent {
  readonly turns = input<readonly TurnNavigationItem[]>([]);
  readonly active = input("");
  readonly selected = output<string>();
}
