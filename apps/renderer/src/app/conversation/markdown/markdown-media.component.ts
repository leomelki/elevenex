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
import { MarkdownRecordingComponent } from "./markdown-recording.component";
import { safeMediaSource, type MarkdownAsset } from "./markdown-parser";
@Component({
  selector: "ex-markdown-media",
  imports: [A11yModule, MarkdownRecordingComponent],
  templateUrl: "./markdown-media.component.html",
  styleUrl: "./markdown-media.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarkdownMediaComponent {
  readonly path = input.required<string>();
  readonly caption = input("");
  readonly asset = input<MarkdownAsset | null>();
  readonly openFile = output<string>();
  readonly openPage = output<string>();
  readonly viewerOpen = signal(false);
  readonly viewer = viewChild<ElementRef<HTMLDialogElement>>("viewer");
  readonly safeSource = computed(() => {
    const asset = this.asset();
    return asset && asset.kind !== "page"
      ? safeMediaSource(asset.src ?? "")
      : "";
  });
  showViewer(): void {
    this.viewerOpen.set(true);
    this.viewer()?.nativeElement.showModal();
  }
  closeViewer(): void {
    this.viewer()?.nativeElement.close();
    this.viewerOpen.set(false);
  }
}
