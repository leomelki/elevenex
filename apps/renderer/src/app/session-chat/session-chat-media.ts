import { DestroyRef, Injectable, inject, signal } from "@angular/core";
import type { SessionChatItem } from "@elevenex/shared";
import { SessionChatClient } from "../backend/session-chat-client.service";
import type { MarkdownAsset, MarkdownAssetResolver } from "../conversation";
import type { ChatSelection } from "./session-chat.store";

interface MediaReference {
  readonly itemId: string;
  readonly id: string;
  readonly path: string;
  readonly kind?: 'image' | 'video';
}

/** One selected chat owns a bounded image window and all its in-flight reads. */
@Injectable()
export class SessionChatMedia {
  private readonly client = inject(SessionChatClient);
  private readonly assets = signal<ReadonlyMap<string, MarkdownAsset>>(
    new Map(),
  );
  private selection: ChatSelection | undefined;
  private queue: MediaReference[] = [];
  private readonly decoders = new Set<HTMLImageElement>();
  private readonly requests = new Map<MediaReference, string>();
  private references = new Map<string, MediaReference>();
  readonly resolve: MarkdownAssetResolver = (path) => this.assets().get(path);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.reset());
  }

  update(selection: ChatSelection | null, items: readonly SessionChatItem[]): void {
    if (!selection) { this.reset(); this.selection = undefined; return; }
    if (
      this.selection?.scopeId !== selection.scopeId ||
      this.selection.taskId !== selection.taskId ||
      this.selection.sessionId !== selection.sessionId
    ) {
      this.reset();
      this.selection = selection;
    }
    const references = new Map<string, MediaReference>();
    for (let index = items.length - 1; index >= 0 && references.size < 12; index--) {
      const item = items[index]!;
      for (let offset = (item.media?.length ?? 0) - 1; offset >= 0 && references.size < 12; offset--) {
        const media = item.media![offset]!;
        if (media.kind === 'file' || references.has(media.path)) continue;
        const previous = this.references.get(media.path);
        const reference = previous?.itemId === item.id && previous.id === media.id && previous.kind === media.kind
          ? previous : { itemId: item.id, id: media.id, path: media.path, kind: media.kind };
        references.set(media.path, reference);
      }
    }
    const added = [...references.values()].filter(ref => this.references.get(ref.path) !== ref);
    if (!added.length && references.size === this.references.size) return;
    const previous = this.references;
    this.references = references;
    for (const [ref, request] of this.requests)
      if (previous.get(ref.path) === ref && !this.current(ref)) this.client.cancel(selection.scopeId, request);
    this.queue = this.queue.filter(ref => this.current(ref));
    // Declare every frame's media kind before the bounded transport queue runs.
    // Otherwise the fourth video briefly lays out as an unknown image and gains
    // a control row only when a request slot becomes free.
    this.assets.update(assets => {
      const next = new Map([...assets].filter(([path]) => references.get(path) === previous.get(path)));
      for (const ref of added) next.set(ref.path, {
        kind: ref.kind === 'video' ? 'video' : 'image', src: '', w: 0, h: 0, loading: true,
      });
      return next;
    });
    this.queue.push(...added.reverse());
    this.pump();
  }

  private current(ref: MediaReference): boolean {
    return this.references.get(ref.path) === ref;
  }

  private pump(): void {
    const selection = this.selection;
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
        this.set(ref.path, {
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
      this.set(ref.path, {
        kind: "image",
        src: result.value.source,
        w: width,
        h: height,
      });
    } catch {
      if (this.current(ref))
        this.set(ref.path, {
          kind: ref.kind === "video" ? "video" : "image",
          src: "",
          w: 0,
          h: 0,
          error:
            "Could not load this attachment. Reopen the conversation to retry.",
        });
    } finally {
      if (this.requests.delete(ref)) this.pump();
    }
  }
  private set(path: string, asset: MarkdownAsset): void {
    this.assets.update((assets) => new Map(assets).set(path, asset));
  }
  private reset(): void {
    if (this.selection)
      for (const id of this.requests.values())
        this.client.cancel(this.selection.scopeId, id);
    this.requests.clear();
    for (const decoder of this.decoders) decoder.src = "";
    this.decoders.clear();
    this.references.clear();
    if (this.assets().size) this.assets.set(new Map());
    this.queue = [];
  }
}
