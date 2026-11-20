import { DestroyRef, Injectable, computed, inject, signal } from "@angular/core";
import type { SessionChatItem } from "@elevenex/shared";
import { SessionChatClient } from "../backend/session-chat-client.service";
import type { MarkdownAsset, MarkdownAssetResolver, ToolImage, ToolImageProvider, ToolImageResolver } from "../conversation";
import type { ChatSelection } from "./session-chat.store";
import { imageViewCallIds, isViewedImageResult } from "./session-chat-tools";

const MEDIA_WINDOW = 12;
// Tool previews keep their receipt identity even when a message embeds the same path.
type MediaKey = string | ToolImage;
interface MediaReference {
  readonly key: MediaKey;
  readonly itemId: string;
  readonly id: string;
  readonly kind?: 'image' | 'video';
}

/** One selected chat owns its bounded media windows and all their in-flight reads. */
@Injectable()
export class SessionChatMedia {
  private readonly client = inject(SessionChatClient);
  private readonly assets = signal<ReadonlyMap<MediaKey, MarkdownAsset>>(
    new Map(),
  );
  private readonly selection = signal<ChatSelection | null>(null);
  private queue: MediaReference[] = [];
  private readonly decoders = new Set<HTMLImageElement>();
  private readonly requests = new Map<MediaReference, string>();
  private passive = new Map<string, MediaReference>();
  private readonly observed = new Map<ToolImage, number>();
  private references = new Map<MediaKey, MediaReference>();
  readonly resolve: MarkdownAssetResolver = (path) => this.assets().get(path);
  readonly toolImages = computed<ToolImageProvider | undefined>(() => {
    const selection = this.selection();
    return selection ? (images, signal) => this.observe(selection, images, signal) : undefined;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.reset();
      this.selection.set(null);
    });
  }

  update(selection: ChatSelection | null, items: readonly SessionChatItem[]): void {
    const current = this.selection();
    if (
      current?.scopeId !== selection?.scopeId ||
      current?.taskId !== selection?.taskId ||
      current?.sessionId !== selection?.sessionId
    ) {
      this.reset();
      this.selection.set(selection);
    }
    if (!selection) return;
    const passive = new Map<string, MediaReference>();
    const viewCalls = imageViewCallIds(items);
    for (let index = items.length - 1; index >= 0 && passive.size < MEDIA_WINDOW; index--) {
      const item = items[index]!;
      if (isViewedImageResult(item, viewCalls)) continue;
      for (let offset = (item.media?.length ?? 0) - 1; offset >= 0 && passive.size < MEDIA_WINDOW; offset--) {
        const media = item.media![offset]!;
        if (media.kind === 'file' || passive.has(media.path)) continue;
        const previous = this.passive.get(media.path);
        const reference = previous?.itemId === item.id && previous.id === media.id && previous.kind === media.kind
          ? previous : { itemId: item.id, id: media.id, key: media.path, kind: media.kind };
        passive.set(media.path, reference);
      }
    }
    this.passive = passive;
    this.reconcile(selection.scopeId);
  }

  private observe(selection: ChatSelection, images: readonly ToolImage[], signal: AbortSignal): ToolImageResolver {
    if (this.selection() !== selection || signal.aborted) return () => undefined;
    for (const image of images) {
      const observers = this.observed.get(image) ?? 0;
      this.observed.delete(image);
      this.observed.set(image, observers + 1);
    }
    this.reconcile(selection.scopeId);
    signal.addEventListener('abort', () => {
      if (this.selection() !== selection) return;
      for (const image of images) {
        const observers = this.observed.get(image) ?? 0;
        if (observers <= 1) this.observed.delete(image);
        else this.observed.set(image, observers - 1);
      }
      this.reconcile(selection.scopeId);
    }, { once: true });
    return image => this.assets().get(image);
  }

  private reconcile(scopeId: string): void {
    const references = new Map<MediaKey, MediaReference>(this.passive);
    for (const image of [...this.observed.keys()].slice(-MEDIA_WINDOW)) {
      references.set(image, this.references.get(image) ?? { key: image, itemId: image.itemId, id: image.mediaId });
    }
    const added = [...references.values()].filter(ref => this.references.get(ref.key) !== ref);
    if (!added.length && references.size === this.references.size) return;
    const previous = this.references;
    this.references = references;
    for (const [ref, request] of this.requests)
      if (previous.get(ref.key) === ref && !this.current(ref)) this.client.cancel(scopeId, request);
    this.queue = this.queue.filter(ref => this.current(ref));
    // Declare every frame's media kind before the bounded transport queue runs.
    // Otherwise the fourth video briefly lays out as an unknown image and gains
    // a control row only when a request slot becomes free.
    this.assets.update(assets => {
      const next = new Map([...assets].filter(([key]) => references.get(key) === previous.get(key)));
      for (const ref of added) next.set(ref.key, {
        kind: ref.kind === 'video' ? 'video' : 'image', src: '', w: 0, h: 0, loading: true,
      });
      return next;
    });
    this.queue.unshift(...added.filter(ref => typeof ref.key !== 'string'));
    this.queue.push(...added.filter(ref => typeof ref.key === 'string').reverse());
    this.pump();
  }

  private current(ref: MediaReference): boolean {
    return this.references.get(ref.key) === ref;
  }

  private pump(): void {
    const selection = this.selection();
    if (!selection) return;
    while (this.queue.length && this.requests.size < 3) {
      const ref = this.queue.shift();
      if (!ref) break;
      const id = crypto.randomUUID();
      this.requests.set(ref, id);
      void this.load(selection, ref, id);
    }
  }
  private async load(
    selection: ChatSelection,
    ref: MediaReference,
    id: string,
  ): Promise<void> {
    try {
      const result = await this.client.media(selection.scopeId, {
        ...selection,
        requestId: id,
        itemId: ref.itemId,
        mediaId: ref.id,
      });
      if (!this.current(ref)) return;
      if (!result.ok) throw new Error("Media read failed.");
      const budget = [...this.assets().values()].reduce(
        (sum, asset) =>
          sum + (asset.kind !== "page" ? (asset.src?.length ?? 0) : 0),
        0,
      );
      if (budget + result.value.source.length > 48 * 1024 * 1024)
        throw new Error("Media display budget exceeded.");
      if (ref.kind === "video") {
        this.set(ref.key, {
          kind: "video",
          src: result.value.source,
          w: 0,
          h: 0,
        });
        return;
      }
      const decoder = new Image();
      this.decoders.add(decoder);
      let width: number, height: number;
      try {
        decoder.src = result.value.source;
        await decoder.decode();
        width = decoder.naturalWidth;
        height = decoder.naturalHeight;
      } finally {
        this.decoders.delete(decoder);
        decoder.src = "";
      }
      if (!this.current(ref)) return;
      const bytes = [...this.assets().values()].reduce(
        (sum, asset) =>
          sum + (asset.kind !== "page" ? (asset.src?.length ?? 0) : 0),
        0,
      );
      if (
        !width ||
        !height ||
        bytes + result.value.source.length > 48 * 1024 * 1024
      )
        throw new Error("Image exceeds the display budget.");
      this.set(ref.key, {
        kind: "image",
        src: result.value.source,
        w: width,
        h: height,
      });
    } catch {
      if (this.current(ref))
        this.set(ref.key, {
          kind: ref.kind === "video" ? "video" : "image",
          src: "",
          w: 0,
          h: 0,
          error: typeof ref.key === 'string'
            ? "Could not load this attachment. Reopen the conversation to retry."
            : "Could not load this image. Reopen the tool to retry.",
        });
    } finally {
      if (this.requests.delete(ref)) this.pump();
    }
  }
  private set(key: MediaKey, asset: MarkdownAsset): void {
    this.assets.update((assets) => new Map(assets).set(key, asset));
  }
  private reset(): void {
    const selection = this.selection();
    if (selection)
      for (const id of this.requests.values())
        this.client.cancel(selection.scopeId, id);
    this.requests.clear();
    for (const decoder of this.decoders) decoder.src = "";
    this.decoders.clear();
    this.references.clear();
    this.passive.clear();
    this.observed.clear();
    if (this.assets().size) this.assets.set(new Map());
    this.queue = [];
  }
}
