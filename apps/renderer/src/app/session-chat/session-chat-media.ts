import { DestroyRef, Injectable, inject, signal } from "@angular/core";
import type { SessionChatItem } from "@elevenex/shared";
import { SessionChatClient } from "../backend/session-chat-client.service";
import type { MarkdownAsset, MarkdownAssetResolver } from "../conversation";
import type { ChatSelection } from "./session-chat.store";

/** One selected chat owns a bounded image window and all its in-flight reads. */
@Injectable()
export class SessionChatMedia {
  private readonly client = inject(SessionChatClient);
  private readonly assets = signal<ReadonlyMap<string, MarkdownAsset>>(
    new Map(),
  );
  private selection: ChatSelection | undefined;
  private generation = 0;
  private queue: {
    itemId: string;
    id: string;
    path: string;
    kind?: "image" | "video" | "file";
  }[] = [];
  private readonly decoders = new Set<HTMLImageElement>();
  private readonly requests = new Set<string>();
  private readonly known = new Set<string>();
  readonly resolve: MarkdownAssetResolver = (path) => this.assets().get(path);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.reset());
  }

  update(selection: ChatSelection, items: readonly SessionChatItem[]): void {
    if (
      this.selection?.scopeId !== selection.scopeId ||
      this.selection.taskId !== selection.taskId ||
      this.selection.sessionId !== selection.sessionId
    ) {
      this.reset();
      this.selection = selection;
    }
    const refs = items
      .flatMap((item) =>
        (item.media ?? [])
          .filter((media) => media.kind !== "file")
          .map((media) => ({ itemId: item.id, ...media })),
      )
      .slice(-12);
    const paths = new Set(refs.map((ref) => ref.path));
    this.assets.update(
      (assets) => new Map([...assets].filter(([path]) => paths.has(path))),
    );
    for (const path of this.known)
      if (!paths.has(path)) this.known.delete(path);
    this.queue = this.queue.filter((ref) => paths.has(ref.path));
    const queue = refs.filter((ref) => !this.known.has(ref.path));
    for (const ref of queue) this.known.add(ref.path);
    this.queue.push(...queue);
    this.pump();
  }
  private pump(): void {
    const selection = this.selection;
    if (!selection) return;
    const generation = this.generation;
    while (this.queue.length && this.requests.size < 3) {
      const ref = this.queue.shift();
      if (!ref) break;
      const id = crypto.randomUUID();
      this.requests.add(id);
      this.set(ref.path, {
        kind: ref.kind === "video" ? "video" : "image",
        src: "",
        w: 0,
        h: 0,
        loading: true,
      });
      void this.load(selection, ref, id, generation);
    }
  }
  private async load(
    selection: ChatSelection,
    ref: {
      itemId: string;
      id: string;
      path: string;
      kind?: "image" | "video" | "file";
    },
    id: string,
    generation: number,
  ): Promise<void> {
    try {
      const result = await this.client.media(selection.scopeId, {
        ...selection,
        requestId: id,
        itemId: ref.itemId,
        mediaId: ref.id,
      });
      if (generation !== this.generation || !this.known.has(ref.path)) return;
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
      if (generation !== this.generation || !this.known.has(ref.path)) return;
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
      if (generation === this.generation && this.known.has(ref.path))
        this.set(ref.path, {
          kind: ref.kind === "video" ? "video" : "image",
          src: "",
          w: 0,
          h: 0,
          error:
            "Could not load this attachment. Reopen the conversation to retry.",
        });
    } finally {
      this.requests.delete(id);
      if (generation === this.generation) this.pump();
    }
  }
  private set(path: string, asset: MarkdownAsset): void {
    this.assets.update((assets) => new Map(assets).set(path, asset));
  }
  private reset(): void {
    this.generation++;
    if (this.selection)
      for (const id of this.requests)
        this.client.cancel(this.selection.scopeId, id);
    this.requests.clear();
    for (const decoder of this.decoders) decoder.src = "";
    this.decoders.clear();
    this.known.clear();
    this.assets.set(new Map());
    this.queue = [];
  }
}
