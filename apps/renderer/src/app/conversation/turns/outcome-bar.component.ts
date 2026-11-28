import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { ButtonComponent, IconComponent } from "../../ui";
import type { ChangedFile } from "../conversation.models";
import { FileChipComponent } from "./file-chip.component";
@Component({
  selector: "ex-outcome-bar",
  imports: [ButtonComponent, IconComponent, FileChipComponent],
  template: `@if (files().length) {
    <div class="files">
      @for (file of visible(); track file.path) {
        <ex-file-chip [file]="file" (selected)="openFile.emit($event)" />
      }
      @if (remaining()) {
        <button exButton variant="ghost" size="sm" (click)="review.emit()">
          +{{ remaining() }} more
        </button>
      }
    </div>
    @if (action()) {
      <button exButton variant="secondary" size="sm" (click)="review.emit()">
        <ex-icon [name]="actionIcon()" [size]="14" />{{ action() }}
      </button>
    }
  }`,
  styles: `
    :host {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      min-width: 0;
    }
    .files {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      min-width: 0;
      flex: 1;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OutcomeBarComponent {
  readonly files = input<readonly ChangedFile[]>([]);
  readonly filesTotal = input<number>();
  readonly max = input(3);
  readonly action = input("Review");
  readonly actionIcon = input("changes");
  readonly openFile = output<string>();
  readonly review = output<void>();
  readonly visible = computed(() =>
    this.files().slice(0, Math.max(0, this.max())),
  );
  readonly remaining = computed(() =>
    Math.max(0, (this.filesTotal() ?? this.files().length) - this.visible().length),
  );
}
