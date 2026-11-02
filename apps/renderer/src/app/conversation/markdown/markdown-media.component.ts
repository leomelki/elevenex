import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import { ImageViewerComponent } from "./image-viewer.component";
import { MarkdownRecordingComponent } from "./markdown-recording.component";
import { safeMediaSource, type MarkdownAsset } from "./markdown-parser";
@Component({
  selector: "ex-markdown-media",
  imports: [ImageViewerComponent, MarkdownRecordingComponent],
  templateUrl: "./markdown-media.component.html",
  styleUrl: "./markdown-media.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class.compact]": "compact()" },
})
export class MarkdownMediaComponent {
  readonly path = input.required<string>();
  readonly caption = input("");
  readonly showCaption = input(true);
  readonly compact = input(false);
  readonly asset = input<MarkdownAsset | null>();
  readonly openFile = output<string>();
  readonly openPage = output<string>();
  readonly viewerOpen = signal(false);
  readonly failedSource = signal<string | null>(null);
  // Retain the source and opener through the modal's exit, even if the asset updates.
  readonly viewer = signal<{ source: string; label: string; from: HTMLElement } | null>(null);
  readonly safeSource = computed(() => {
    const asset = this.asset();
    return asset && asset.kind !== "page"
      ? safeMediaSource(asset.src ?? "")
      : "";
  });
  showViewer(from: HTMLElement): void {
    this.viewer.set({ source: this.safeSource(), label: this.caption() || this.path(), from });
    this.viewerOpen.set(true);
  }
}
