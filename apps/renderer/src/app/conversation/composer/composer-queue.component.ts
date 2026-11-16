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
import { displayElementMentions, elementMentionNames, encodeElementMentions } from '../element/element-mention-text';
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
  /** Queued prose uses the same readable names as the draft, without its envelope. */
  preview(text: string): string {
    const { prose, names } = this.split(text);
    return displayElementMentions(prose, names);
  }
  private split(text: string): { prose: string; context: string; names: ReadonlyMap<number, string> } {
    const parsed = parseBrowserElements(text);
    const names = elementMentionNames(parsed.elements.map(element => ({ element: element.reference, marker: element.marker })));
    if (!parsed.elements.length) return { prose: text, context: "", names };
    const isElementImage = (line: string) => parsed.elements.some(element => line.startsWith('[' + element.attachment + ']'));
    const lines = parsed.text.split('\n');
    return {
      names,
      prose: lines.filter(line => !isElementImage(line)).join('\n').trim(),
      context: [serializeBrowserElements(parsed.elements), ...lines.filter(isElementImage)].join('\n\n'),
    };
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
  private retainedNames: ReadonlyMap<number, string> = new Map();
  beginEdit(item: QueuedMessage): void {
    if (this.disabled() || !this.editable() || item.editable === false) return;
    this.editing.set(item.id);
    this.editingChanged.emit(item.id);
    const { prose, context, names } = this.split(item.text);
    this.retainedContext = context;
    this.retainedNames = names;
    this.editText.set(displayElementMentions(prose, names));
  }
  ngOnChanges(): void { const id = this.editing(); if (id && !this.items().some(item => item.id === id)) this.cancelEdit(); }
  cancelEdit(): void { this.retainedContext = ""; this.retainedNames = new Map(); this.editing.set(null); this.editingChanged.emit(null); }
  update(event: Event): void {
    if (event.target instanceof HTMLTextAreaElement)
      this.editText.set(event.target.value);
  }
  save(id: string): void {
    if (this.disabled() || !this.editable() || !this.editText().trim()) return;
    this.edited.emit({ id, text: [encodeElementMentions(this.editText().trim(), this.retainedNames), this.retainedContext].filter(Boolean).join("\n\n") });
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
