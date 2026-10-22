import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { IconComponent } from "../icon/icon.component";
@Component({
  selector: "ex-new-messages-pill",
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" (click)="jumped.emit()">
    <ex-icon name="arrow-down" [size]="13" />{{ count() }} new
    {{ count() === 1 ? "message" : "messages" }}
  </button>`,
  styles: `
    button {
      font: inherit;
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      height: 28px;
      padding: 0 var(--space-3);
      border: 1px solid var(--line);
      border-radius: var(--radius-full);
      background: var(--surface-raised);
      color: var(--ink);
      font-weight: 500;
      box-shadow: var(--shadow-pop);
      cursor: pointer;
    }
    button:hover {
      background: var(--surface-sunken);
    }
  `,
})
export class NewMessagesPillComponent {
  readonly count = input(1);
  readonly jumped = output<void>();
}
