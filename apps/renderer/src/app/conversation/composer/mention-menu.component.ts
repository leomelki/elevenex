import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from "@angular/core";
import { IconComponent } from "../../ui";
import { MentionComponent } from "./mention.component";
import type { ConversationMention } from "../conversation.models";
@Component({
  selector: "ex-mention-menu",
  imports: [IconComponent, MentionComponent],
  templateUrl: "./mention-menu.component.html",
  styleUrl: "./mention-menu.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(keydown)": "onKey($event)" },
})
export class MentionMenuComponent {
  readonly query = input("");
  readonly listId = input(`mentions-${crypto.randomUUID()}`);
  readonly items = input<readonly ConversationMention[]>([]);
  /** Optional trailing command, e.g. starting a browser element pick. */
  readonly actionLabel = input("");
  readonly selected = output<ConversationMention>();
  readonly action = output<void>();
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
  readonly optionCount = computed(
    () => this.matches().length + (this.actionLabel() ? 1 : 0),
  );
  readonly activeOptionId = computed(() =>
    this.optionCount() ? `${this.listId()}-${this.highlighted()}` : null,
  );
  /** Elements staged in this message are the likeliest reference, so they lead. */
  rank(kind: ConversationMention["kind"]): number {
    return kind === "element" ? 0 : kind === "session" ? 1 : kind === "task" ? 2 : 3;
  }
  onKey(event: KeyboardEvent): void {
    const matches = this.matches();
    if (event.key === "Escape") {
      event.preventDefault();
      this.closed.emit();
      return;
    }
    const count = this.optionCount();
    if (!count) return;
    let index = Math.min(this.highlighted(), count - 1);
    if (event.key === "ArrowDown") index = (index + 1) % count;
    else if (event.key === "ArrowUp") index = (index + count - 1) % count;
    else if (event.key === "Tab") {
      const current = matches[index];
      const next = matches.findIndex(
        (item, i) => i > index && item.kind !== current?.kind,
      );
      index = next >= 0 ? next : index < matches.length && count > matches.length ? matches.length : 0;
    } else if (event.key === "Enter") {
      const item = matches[index];
      if (item) this.selected.emit(item);
      else if (index === matches.length && this.actionLabel()) this.action.emit();
    } else return;
    event.preventDefault();
    this.highlighted.set(index);
  }
}
