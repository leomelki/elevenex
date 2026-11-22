import { A11yModule } from "@angular/cdk/a11y";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
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
  type MarkdownAsset,
} from "./markdown-parser";
interface GroupSlot extends MarkdownEmbed {
  readonly asset: MarkdownAsset | null | undefined;
  readonly image: GroupImage | null;
  readonly loading: boolean;
  readonly status: string;
}
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
  readonly active = input(true);
  readonly openFile = output<string>();
  readonly openPage = output<string>();
  readonly viewer = viewChild<ElementRef<HTMLDialogElement>>("viewer");
  private readonly viewerPath = signal('');
  private readonly failedSources = signal<ReadonlySet<string>>(new Set());
  readonly viewerOpen = signal(false);
  readonly wipe = signal(50);
  // Layout comes from the embed list, before the confined resolver has any bytes.
  readonly slots = computed<readonly GroupSlot[]>(() => this.items().map(item => {
    const asset = this.resolve()?.(item.path);
    const source = asset?.kind === 'image' ? safeMediaSource(asset.src) : '';
    const loading = !!asset && asset.kind !== 'page' && !!asset.loading;
    const error = asset && asset.kind !== 'page' ? asset.error : undefined;
    const image = asset?.kind === 'image' && source && !loading && !error && !this.failedSources().has(source)
      ? { ...item, src: source, w: asset.w, h: asset.h } : null;
    return { ...item, asset, image, loading, status: loading ? 'Loading image…' : error || 'Image unavailable' };
  }));
  readonly images = computed<readonly GroupImage[]>(() => this.slots().flatMap(slot => slot.image ? [slot.image] : []));
  readonly comparison = computed(() => {
    const slots = this.slots();
    return slots.length === 2 &&
      /^before\b/i.test(slots[0]?.caption ?? '') && /^after\b/i.test(slots[1]?.caption ?? '') &&
      slots.every(({ asset }) => !asset || asset.kind === 'image');
  });
  readonly comparisonReady = computed(() => this.images().length === 2);
  readonly viewerIndex = computed(() => Math.max(0, this.images().findIndex(image => image.path === this.viewerPath())));
  readonly current = computed(() => this.images()[this.viewerIndex()]);
  constructor() {
    effect(() => {
      if (!this.active() && this.viewerOpen()) this.close();
    });
  }
  failed(source: string): void {
    this.failedSources.update(previous => new Set([...previous, source]));
  }
  open(value: number | string): void {
    if (!this.active()) return;
    const path = typeof value === 'number' ? this.images()[value]?.path : value;
    if (!path || !this.images().some(image => image.path === path)) return;
    this.viewerPath.set(path);
    this.viewerOpen.set(true);
    this.viewer()?.nativeElement.showModal();
  }
  openUnavailable(slot: GroupSlot): void {
    if (slot.asset?.kind === 'page') this.openPage.emit(slot.path);
    else this.openFile.emit(slot.path);
  }
  close(): void {
    this.viewer()?.nativeElement.close();
    this.viewerOpen.set(false);
  }
  step(delta: number): void {
    const count = this.images().length;
    if (count)
      this.viewerPath.set(this.images()[(this.viewerIndex() + delta + count) % count]!.path);
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
