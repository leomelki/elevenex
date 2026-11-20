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
  TurnWorkAction,
  TurnWorkToggle,
  TurnNavigationItem,
} from "../conversation.models";
import type { ToolContentRequest, ToolDetailsProvider } from '../tool-presentation';
import type { MarkdownAssetResolver } from "../markdown/markdown-parser";
import { TurnComponent } from "../turns/turn.component";
import { TurnNavComponent } from "../turns/turn-nav.component";
import { ChatScrollComponent } from "./chat-scroll.component";
import { MessageComponent } from "./message.component";
import { AttachmentsComponent } from "./attachments.component";
import { ButtonComponent } from '../../ui';
import { MentionComponent } from '../composer/mention.component';
import { ElementProseComponent } from '../element/element-prose.component';
@Component({
  selector: "ex-chat",
  imports: [
    ButtonComponent,
    AttachmentsComponent,
    TurnComponent,
    TurnNavComponent,
    ChatScrollComponent,
    MessageComponent,
    MentionComponent,
    ElementProseComponent,
  ],
  templateUrl: "./chat.component.html",
  styleUrl: "./chat.component.css",
  host: { "[class.center-composer]": "centerComposer()" },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatComponent {
  readonly centerComposer = input(false);
  readonly historyBefore = input(false);
  readonly historyAfter = input(false);
  readonly historyLoading = input(false);
  readonly initialHistoryPrefetch = input(true);
  readonly historyError = input("");
  readonly historyRevision = input(0);
  readonly historyRequested = output<"before" | "following">();
  readonly historyCancelled = output<void>();
  readonly latestRequested = output<void>();
  readonly exchanges = input<readonly ChatExchange[]>([]);
  readonly actions = input<readonly TurnAction[]>(['side-chat', 'fork', 'copy']);
  readonly reach = input<{ readonly machine: string; readonly since: number }>();
  readonly stoppable = input(true);
  readonly retryable = input(true);
  readonly copiedCode = input<string | null>(null);
  readonly contentRequested = output<string>();
  readonly toolContentRequested = output<ToolContentRequest>();
  readonly resolve = input<MarkdownAssetResolver>();
  readonly inspectTool = input<ToolDetailsProvider>();
  readonly turnAction = output<{ id: string; action: TurnAction }>();
  readonly turnWorkToggled = output<TurnWorkToggle & { readonly id: string }>();
  readonly turnWorkHint = output<string>();
  readonly turnWorkRequested = output<{ id: string; action: TurnWorkAction }>();
  readonly openFile = output<string>();
  readonly fileReview = output<{ readonly id: string; readonly path: string }>();
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
