import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { IconComponent } from "../../ui";
import type { ChangedFile } from "../conversation.models";
@Component({
  selector: "ex-file-chip",
  imports: [IconComponent],
  template: `<button
    type="button"
    [title]="file().path"
    (click)="selected.emit(file().path)"
  >
    <ex-icon
      [name]="file().status === 'A' ? 'plus' : 'file'"
      [size]="13"
    /><span class="name">{{ name() }}</span
    ><span class="folder">{{ folder() }}</span>
    @if (file().add) {
      <span class="add">+{{ file().add }}</span>
    }
    @if (file().del) {
      <span class="del">−{{ file().del }}</span>
    }
  </button>`,
  styleUrl: "./file-chip.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileChipComponent {
  readonly file = input.required<ChangedFile>();
  readonly selected = output<string>();
  readonly name = computed(
    () => this.file().path.split("/").at(-1) ?? this.file().path,
  );
  readonly folder = computed(() =>
    this.file().path.slice(0, Math.max(0, this.file().path.lastIndexOf("/"))),
  );
}
