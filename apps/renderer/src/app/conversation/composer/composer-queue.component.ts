import { DragDropModule, type CdkDragDrop } from "@angular/cdk/drag-drop";
import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
} from "@angular/core";
import { IconButtonComponent, ButtonComponent } from "../../ui";
import type { QueuedMessage } from "../conversation.models";
@Component({
  selector: "ex-composer-queue",
  imports: [DragDropModule, IconButtonComponent, ButtonComponent],
  templateUrl: "./composer-queue.component.html",
  styleUrl: "./composer-queue.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerQueueComponent {
  readonly items = input<readonly QueuedMessage[]>([]);
  readonly steer = output<string>();
  readonly remove = output<string>();
  readonly edited = output<QueuedMessage>();
  readonly reordered = output<readonly string[]>();
  readonly editing = signal<string | null>(null);
  readonly editText = signal("");
  beginEdit(item: QueuedMessage): void {
    this.editing.set(item.id);
    this.editText.set(item.text);
  }
  update(event: Event): void {
    if (event.target instanceof HTMLTextAreaElement)
      this.editText.set(event.target.value);
  }
  save(id: string): void {
    if (!this.editText().trim()) return;
    this.edited.emit({ id, text: this.editText().trim() });
    this.editing.set(null);
  }
  drop(event: CdkDragDrop<readonly QueuedMessage[]>): void {
    const ids = this.items().map((item) => item.id);
    const [id] = ids.splice(event.previousIndex, 1);
    if (id) {
      ids.splice(event.currentIndex, 0, id);
      this.reordered.emit(ids);
    }
  }
  move(id: string, delta: number): void {
    const ids = this.items().map((item) => item.id);
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + delta));
    if (from < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    this.reordered.emit(ids);
  }
}
