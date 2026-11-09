import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { IconComponent, IconButtonComponent, ButtonComponent } from "../../ui";
import type { ConversationAttachment } from "../conversation.models";
import { ElementChipComponent } from "../element/element-chip.component";
import { MarkdownMediaComponent } from "../markdown/markdown-media.component";
import {
  safeMediaSource,
  type MarkdownAssetResolver,
} from "../markdown/markdown-parser";

/** Supplied attachment views only. The selected-session owner handles bytes and retries. */
@Component({
  selector: "ex-attachments",
  imports: [
    ElementChipComponent,
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
  /** Browser elements read as chips in pin order; other files keep their tiles. */
  readonly elements = computed(() =>
    this.files()
      .filter((file) => file.element)
      .sort((a, b) => (a.marker ?? 0) - (b.marker ?? 0)),
  );
  readonly others = computed(() => this.files().filter((file) => !file.element));
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
