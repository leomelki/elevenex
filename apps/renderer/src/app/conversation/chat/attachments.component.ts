import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { IconComponent, IconButtonComponent, ButtonComponent } from "../../ui";
import type { ConversationAttachment } from "../conversation.models";
import { MarkdownMediaComponent } from "../markdown/markdown-media.component";
import {
  safeMediaSource,
  type MarkdownAssetResolver,
} from "../markdown/markdown-parser";

/** Supplied attachment views only. The selected-session owner handles bytes and retries. */
@Component({
  selector: "ex-attachments",
  imports: [
    IconComponent,
    IconButtonComponent,
    ButtonComponent,
    MarkdownMediaComponent,
  ],
  templateUrl: "./attachments.component.html",
  styleUrl: "./attachments.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AttachmentsComponent {
  readonly files = input<readonly ConversationAttachment[]>([]);
  readonly editing = input(false);
  readonly disabled = input(false);
  readonly resolve = input<MarkdownAssetResolver>();
  readonly removed = output<string>();
  readonly retry = output<string>();
  readonly copyPath = output<string>();
  preview(source: string): string {
    return safeMediaSource(source);
  }
  size(bytes: number): string {
    return bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${Math.ceil(bytes / 1024)} KB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}
