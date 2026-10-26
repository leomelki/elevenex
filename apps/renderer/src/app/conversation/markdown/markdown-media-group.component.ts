import { A11yModule } from "@angular/cdk/a11y";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
  viewChild,
  type ElementRef,
} from "@angular/core";
import { IconButtonComponent } from "../../ui";
import { MarkdownMediaComponent } from "./markdown-media.component";
import {
  safeMediaSource,
  type MarkdownAssetResolver,
  type MarkdownEmbed,
} from "./markdown-parser";
interface GroupImage {
  readonly path: string;
  readonly caption: string;
  readonly src: string;
  readonly w: number;
  readonly h: number;
}
@Component({
  selector: "ex-markdown-media-group",
  imports: [A11yModule, IconButtonComponent, MarkdownMediaComponent],
  templateUrl: "./markdown-media-group.component.html",
  styleUrl: "./markdown-media-group.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarkdownMediaGroupComponent {
  readonly items = input.required<readonly MarkdownEmbed[]>();
  readonly resolve = input<MarkdownAssetResolver>();
  readonly openFile = output<string>();
  readonly openPage = output<string>();
  readonly viewer = viewChild<ElementRef<HTMLDialogElement>>("viewer");
  readonly viewerIndex = signal(0);
  readonly viewerOpen = signal(false);
  readonly wipe = signal(50);
  readonly images = computed<readonly GroupImage[]>(() =>
    this.items().flatMap((item) => {
      const asset = this.resolve()?.(item.path);
      const src = asset?.kind === "image" ? safeMediaSource(asset.src) : "";
      return asset?.kind === "image" && src
        ? [{ ...item, src, w: asset.w, h: asset.h }]
        : [];
    }),
  );
  readonly allImages = computed(
    () => this.images().length === this.items().length,
  );
  readonly comparison = computed(
    () =>
      this.images().length === 2 &&
      /^before\b/i.test(this.images()[0]?.caption ?? "") &&
      /^after\b/i.test(this.images()[1]?.caption ?? ""),
  );
  readonly current = computed(
    () => this.images()[this.viewerIndex()] ?? this.images()[0],
  );
  open(index: number): void {
    this.viewerIndex.set(index);
    this.viewerOpen.set(true);
    this.viewer()?.nativeElement.showModal();
  }
  close(): void {
    this.viewer()?.nativeElement.close();
    this.viewerOpen.set(false);
  }
  step(delta: number): void {
    const count = this.images().length;
    if (count)
      this.viewerIndex.update((index) => (index + delta + count) % count);
  }
  onKey(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      this.step(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      this.step(1);
    } else if (event.key === "Escape") this.viewerOpen.set(false);
  }
  changeWipe(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.wipe.set(Number(event.target.value));
  }
}
