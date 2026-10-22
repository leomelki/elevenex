import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from "@angular/core";
import { MentionComponent } from "./mention.component";
import type { ConversationMention } from "../conversation.models";
@Component({
  selector: "ex-mention-menu",
  imports: [MentionComponent],
  templateUrl: "./mention-menu.component.html",
  styleUrl: "./mention-menu.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(keydown)": "onKey($event)" },
})
export class MentionMenuComponent {
  readonly query = input("");
  readonly listId = input(`mentions-${crypto.randomUUID()}`);
  readonly items = input<readonly ConversationMention[]>([]);
  readonly selected = output<ConversationMention>();
  readonly closed = output<void>();
  readonly matches = computed(() => {
    const query = this.query().toLocaleLowerCase();
    return [...this.items()]
      .filter((item) =>
        `${item.label} ${item.meta ?? ""}`.toLocaleLowerCase().includes(query),
      )
      .sort((a, b) => this.rank(a.kind) - this.rank(b.kind))
      .slice(0, 50);
  });
  readonly highlighted = linkedSignal({
    source: this.matches,
    computation: () => 0,
  });
  readonly activeOptionId = computed(() =>
    this.matches().length ? `${this.listId()}-${this.highlighted()}` : null,
  );
  rank(kind: ConversationMention["kind"]): number {
    return kind === "session" ? 0 : kind === "task" ? 1 : 2;
  }
  onKey(event: KeyboardEvent): void {
    const matches = this.matches();
    if (event.key === "Escape") {
      event.preventDefault();
      this.closed.emit();
      return;
    }
    if (!matches.length) return;
    let index = Math.min(this.highlighted(), matches.length - 1);
    if (event.key === "ArrowDown") index = (index + 1) % matches.length;
    else if (event.key === "ArrowUp")
      index = (index + matches.length - 1) % matches.length;
    else if (event.key === "Tab") {
      const current = matches[index];
      const next = matches.findIndex(
        (item, i) => i > index && item.kind !== current?.kind,
      );
      index = next < 0 ? 0 : next;
    } else if (event.key === "Enter") {
      const item = matches[index];
      if (item) this.selected.emit(item);
    } else return;
    event.preventDefault();
    this.highlighted.set(index);
  }
}
