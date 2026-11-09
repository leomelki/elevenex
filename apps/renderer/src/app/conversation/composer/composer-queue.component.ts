import { parseBrowserElements, serializeBrowserElements } from '@elevenex/shared';
import { DragDropModule, type CdkDragDrop } from "@angular/cdk/drag-drop";
import {
  ChangeDetectionStrategy,
  Component,
  type OnChanges,
  input,
  output,
  signal,
} from "@angular/core";
import {
  IconButtonComponent,
  ButtonComponent,
  IconComponent,
  TickerComponent,
} from "../../ui";
import type { QueuedMessage } from "../conversation.models";
@Component({
  selector: "ex-composer-queue",
  imports: [
    DragDropModule,
    IconButtonComponent,
    ButtonComponent,
    IconComponent,
    TickerComponent,
  ],
  templateUrl: "./composer-queue.component.html",
  styleUrl: "./composer-queue.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerQueueComponent implements OnChanges {
  preview(text: string): string {
    const parsed = parseBrowserElements(text);
    if (!parsed.elements.length) return text;
    return parsed.text.split('\n').filter(line => !parsed.elements.some(element => line.startsWith('[' + element.attachment + ']'))).join('\n').trim() + '\n' + parsed.elements.map(element => element.reference.label + ' (@element-' + element.reference.id.slice(0, 8) + ')').join(' · ');
  }
  readonly items = input<readonly QueuedMessage[]>([]);
  readonly waitingFor = input<string>();
  readonly editable = input(true);
  readonly reorderable = input(true);
  readonly disabled = input(false);
  readonly steer = output<string>();
  readonly remove = output<string>();
  readonly edited = output<QueuedMessage>();
  readonly editingChanged = output<string | null>();
  readonly reordered = output<readonly string[]>();
  readonly editing = signal<string | null>(null);
  readonly editText = signal("");
  private retainedContext = "";
  beginEdit(item: QueuedMessage): void {
    if (this.disabled() || !this.editable() || item.editable === false) return;
    this.editing.set(item.id);
    this.editingChanged.emit(item.id);
    const parsed = parseBrowserElements(item.text);
    const lines = parsed.text.split('\n');
    const isElementImage = (line: string) => parsed.elements.some(element => line.startsWith('[' + element.attachment + ']'));
    this.retainedContext = parsed.elements.length ? [serializeBrowserElements(parsed.elements), ...lines.filter(isElementImage)].join('\n\n') : '';
    this.editText.set(parsed.elements.length ? lines.filter(line => !isElementImage(line)).join('\n').trim() : item.text);
  }
  ngOnChanges(): void { const id = this.editing(); if (id && !this.items().some(item => item.id === id)) this.cancelEdit(); }
  cancelEdit(): void { this.retainedContext = ""; this.editing.set(null); this.editingChanged.emit(null); }
  update(event: Event): void {
    if (event.target instanceof HTMLTextAreaElement)
      this.editText.set(event.target.value);
  }
  save(id: string): void {
    if (this.disabled() || !this.editable() || !this.editText().trim()) return;
    this.edited.emit({ id, text: [this.editText().trim(), this.retainedContext].filter(Boolean).join("\n\n") });
    this.cancelEdit();
  }
  drop(event: CdkDragDrop<readonly QueuedMessage[]>): void {
    if (this.disabled() || !this.reorderable()) return;
    const ids = this.items().map((item) => item.id);
    const [id] = ids.splice(event.previousIndex, 1);
    if (id) {
      ids.splice(event.currentIndex, 0, id);
      this.reordered.emit(ids);
    }
  }
  move(id: string, delta: number): void {
    if (this.disabled() || !this.reorderable()) return;
    const ids = this.items().map((item) => item.id);
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + delta));
    if (from < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    this.reordered.emit(ids);
  }
}
