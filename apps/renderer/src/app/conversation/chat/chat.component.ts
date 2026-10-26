import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import type {
  ChatExchange,
  TurnAction,
  TurnNavigationItem,
} from "../conversation.models";
import { MarkdownComponent } from "../markdown/markdown.component";
import type { MarkdownAssetResolver } from "../markdown/markdown-parser";
import { TurnComponent } from "../turns/turn.component";
import { TurnNavComponent } from "../turns/turn-nav.component";
import { ChatScrollComponent } from "./chat-scroll.component";
import { MessageComponent } from "./message.component";
@Component({
  selector: "ex-chat",
  imports: [
    MarkdownComponent,
    TurnComponent,
    TurnNavComponent,
    ChatScrollComponent,
    MessageComponent,
  ],
  templateUrl: "./chat.component.html",
  styleUrl: "./chat.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatComponent {
  readonly exchanges = input<readonly ChatExchange[]>([]);
  readonly resolve = input<MarkdownAssetResolver>();
  readonly turnAction = output<{ id: string; action: TurnAction }>();
  readonly openFile = output<string>();
  readonly openLink = output<string>();
  readonly openPage = output<string>();
  readonly copyCode = output<string>();
  readonly review = output<string>();
  readonly stop = output<string>();
  readonly retry = output<string>();
  readonly active = signal("");
  readonly scroll = viewChild(ChatScrollComponent);
  readonly navigation = computed<readonly TurnNavigationItem[]>(() =>
    this.exchanges().map((exchange) => ({
      id: exchange.id,
      label: exchange.prompt,
      state:
        exchange.status === "live"
          ? "live"
          : exchange.status === "failed"
            ? "attention"
            : exchange.files?.length
              ? "changes"
              : undefined,
    })),
  );
  focusLastMessage(): void {
    const id = this.exchanges().at(-1)?.id;
    if (id) this.scroll()?.scrollToMessage(id);
  }
}
