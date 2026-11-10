import { A11yModule } from "@angular/cdk/a11y";
import { OverlayModule, type ConnectedPosition } from "@angular/cdk/overlay";
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { BrowserElementReference } from "@elevenex/shared";
import { IconComponent } from "../../ui";
import { PopoverPresence } from "../composer/popover-presence";
import type { ConversationAttachment } from "../conversation.models";
import type { MarkdownAssetResolver } from "../markdown/markdown-parser";
import {
  elementImageSource,
  splitElementLabel,
  thumbnailFrame,
} from "./element-geometry";
import { ElementPreviewComponent } from "./element-preview.component";

const THUMB_WIDTH = 36;
const THUMB_HEIGHT = 26;
const INLINE_THUMB_WIDTH = 24;
const INLINE_THUMB_HEIGHT = 16;

/**
 * A browser element staged with, or sent in, a message: a thumbnail
 * framed on the target and a readable label. Pressing it opens the snapshot in
 * an anchored popover. Capture, upload and browser authority stay with the owner.
 */
@Component({
  selector: "ex-element-chip",
  imports: [
    A11yModule,
    OverlayModule,
    IconComponent,
    ElementPreviewComponent,
  ],
  templateUrl: "./element-chip.component.html",
  styleUrl: "./element-chip.component.css",
  host: { "[class.inline]": "inline()" },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ElementChipComponent {
  readonly file = input.required<ConversationAttachment>();
  readonly resolve = input<MarkdownAssetResolver>();
  /** Draft chip: removable, retryable and able to insert its mention. */
  readonly editing = input(false);
  /** Compact mention within sent prose; keeps the same snapshot interaction. */
  readonly inline = input(false);
  readonly disabled = input(false);
  /** Whether the draft's prose refers to this element; included in its accessible name. */
  readonly mentioned = input(true);
  readonly pickAvailable = input(false);
  readonly removed = output<string>();
  readonly retry = output<string>();
  readonly mention = output<void>();
  readonly repick = output<BrowserElementReference>();
  /** Pointer or focus rests on the chip, so the owner can highlight its name in the prose. */
  readonly highlighted = output<boolean>();

  readonly open = signal(false);
  readonly headingId = `element-chip-${crypto.randomUUID()}`;
  protected readonly presence = new PopoverPresence(
    this.open,
    () => ({
      file: this.file(),
      editing: this.editing(),
      pickAvailable: this.pickAvailable(),
    }),
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement,
    inject(DestroyRef),
  );
  protected readonly positions: ConnectedPosition[] = [
    { originX: "start", originY: "top", overlayX: "start", overlayY: "bottom", offsetY: -8 },
    { originX: "start", originY: "bottom", overlayX: "start", overlayY: "top", offsetY: 8 },
  ];

  readonly element = computed(() => this.file().element);
  readonly label = computed(() => splitElementLabel(this.element()?.label ?? ""));
  readonly source = computed(() => elementImageSource(this.file(), this.resolve()));
  readonly frame = computed(() => {
    const element = this.element();
    return element ? thumbnailFrame(
          element,
          this.inline() ? INLINE_THUMB_WIDTH : THUMB_WIDTH,
          this.inline() ? INLINE_THUMB_HEIGHT : THUMB_HEIGHT,
        ) : null;
  });
  readonly failed = computed(() => this.file().status === "error");
  readonly uploading = computed(() => this.file().status === "uploading");
  readonly name = computed(() => {
    const file = this.file();
    const state = this.uploading()
      ? `, uploading ${file.progress ?? 0}%`
      : this.failed()
        ? `, upload failed`
        : this.editing() && !this.mentioned()
          ? ", not referenced in your message"
          : "";
    return `${this.element()?.label ?? file.name}${state}. Show snapshot`;
  });

  constructor() {
    effect(() => {
      if (this.disabled()) this.open.set(false);
    });
  }
  toggle(): void {
    if (!this.disabled()) this.open.update((open) => !open);
  }
  close(): void {
    this.open.set(false);
  }
  insert(): void {
    this.close();
    this.mention.emit();
  }
  pickAgain(reference: BrowserElementReference): void {
    this.close();
    this.repick.emit(reference);
  }
  remove(id: string): void {
    this.close();
    this.highlighted.emit(false);
    this.removed.emit(id);
  }
}
