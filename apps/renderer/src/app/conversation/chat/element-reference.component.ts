import { NgStyle } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import {
  ButtonComponent,
  IconComponent,
  IconButtonComponent,
  ModalLayerComponent,
} from "../../ui";
import type { ConversationAttachment } from "../conversation.models";
import {
  safeMediaSource,
  type MarkdownAssetResolver,
} from "../markdown/markdown-parser";

/** Historical visual context. The owner supplies confined media and handles upload intents. */
@Component({
  selector: "ex-element-reference",
  imports: [
    NgStyle,
    ButtonComponent,
    IconComponent,
    IconButtonComponent,
    ModalLayerComponent,
  ],
  templateUrl: "./element-reference.component.html",
  styleUrl: "./element-reference.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ElementReferenceComponent {
  readonly file = input.required<ConversationAttachment>();
  readonly editing = input(false);
  readonly disabled = input(false);
  readonly resolve = input<MarkdownAssetResolver>();
  readonly removed = output<string>();
  readonly retry = output<string>();
  readonly mention = output<void>();
  readonly pickAgain = output<NonNullable<ConversationAttachment["element"]>>();
  readonly details = signal(false);
  readonly retained = signal(false);
  readonly dialogId = `element-${crypto.randomUUID()}`;
  readonly capturedTime = computed(() => {
    const date = new Date(this.file().element?.capturedAt ?? "");
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(date)
      : "an earlier time";
  });
  readonly alias = computed(
    () => "element-" + this.file().element?.id.slice(0, 8),
  );
  readonly source = computed(() => {
    const file = this.file(),
      asset = this.resolve()?.(file.path);
    return safeMediaSource(
      file.preview || (asset?.kind === "image" ? asset.src : "") || "",
    );
  });
  readonly thumbnailWidth = computed(() => {
    const image = this.file().element?.image;
    return image ? Math.min(76, (56 * image.width) / image.height) : 76;
  });
  readonly targetStyle = computed(() => {
    const element = this.file().element;
    if (!element) return {};
    const { target, crop } = element;
    const left = Math.max(0, target.x - crop.x),
      top = Math.max(0, target.y - crop.y);
    return {
      left: `${(100 * left) / crop.width}%`,
      top: `${(100 * top) / crop.height}%`,
      width: `${(100 * Math.max(0, Math.min(crop.width, target.x + target.width - crop.x) - left)) / crop.width}%`,
      height: `${(100 * Math.max(0, Math.min(crop.height, target.y + target.height - crop.y) - top)) / crop.height}%`,
    };
  });
  open(): void {
    if (!this.disabled()) {
      this.retained.set(true);
      this.details.set(true);
    }
  }
}
