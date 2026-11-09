import type { BrowserElementSnapshot } from '@elevenex/shared';
import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from "@angular/core";
import { SessionChatClient } from "../backend/session-chat-client.service";
import { SessionChatDrafts, type AttachmentDraft } from "./session-chat-drafts";
import type { ChatSelection } from "./session-chat.store";

/** Owns selected-file reads/uploads. Draft data has workspace lifetime; requests have selection lifetime. */
@Injectable()
export class SessionChatAttachments {
  private readonly client = inject(SessionChatClient);
  private readonly drafts = inject(SessionChatDrafts);
  private readonly entry = signal<ReturnType<
    SessionChatDrafts["entry"]
  > | null>(null);
  private selection: ChatSelection | null = null;
  private generation = 0;
  private work: (() => Promise<void>)[] = [];
  private working = false;
  private readonly readers = new Set<FileReader>();
  private readonly requests = new Map<string, string>();
  readonly files = computed(() => this.entry()?.files() ?? []);
  readonly error = signal("");
  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancel());
  }
  open(selection: ChatSelection): void {
    if (
      this.selection?.scopeId === selection.scopeId &&
      this.selection.sessionId === selection.sessionId &&
      this.selection.taskId === selection.taskId
    )
      return;
    this.cancel();
    this.selection = selection;
    this.entry.set(this.drafts.entry(selection.scopeId, selection.sessionId));
    this.error.set("");
  }
  private cancel(): void {
    this.generation++;
    this.work = [];
    for (const reader of this.readers) reader.abort();
    this.readers.clear();
    if (this.selection)
      for (const request of this.requests.values())
        this.client.cancel(this.selection.scopeId, request);
    this.requests.clear();
    this.entry()?.files.update((files) =>
      files.map((file) =>
        file.status === "uploading"
          ? { ...file, status: "error", error: "Upload interrupted" }
          : file,
      ),
    );
  }
  addElement(snapshot: BrowserElementSnapshot): boolean {
    if (!this.entry() || !this.selection) { this.error.set('Open an active conversation before adding the snapshot.'); return false; }
    if (!snapshot.jpeg) { this.error.set(snapshot.error || 'Snapshot unavailable. Pick the element again.'); return false; }
    if (this.files().some(file => file.element?.id === snapshot.reference.id)) return true;
    const bytes = Uint8Array.from(atob(snapshot.jpeg), char => char.charCodeAt(0));
    this.add([new File([bytes], `element-${snapshot.reference.id}.jpg`, { type: 'image/jpeg' })], snapshot);
    return this.files().some(file => file.element?.id === snapshot.reference.id);
  }
  add(files: readonly File[], snapshot?: BrowserElementSnapshot): void {
    const entry = this.entry(),
      selection = this.selection;
    if (!entry || !selection) return;
    this.error.set("");
    const accepted: AttachmentDraft[] = [];
    let size = this.files().reduce((n, f) => n + f.file.size, 0);
    let imageSize = this.files()
      .filter((f) => f.kind === "image")
      .reduce((n, f) => n + f.file.size, 0);
    for (const file of files.slice(0, 9)) {
      const kind = /\.(png|jpe?g|gif|webp)$/i.test(file.name)
        ? "image"
        : /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name)
          ? "video"
          : "file";
      if (
        this.files().length + accepted.length >= 8 ||
        file.size > 20 * 1024 * 1024 ||
        size + file.size > 32 * 1024 * 1024 ||
        (kind === "image" && imageSize + file.size > 8 * 1024 * 1024)
      ) {
        this.error.set(
          "Attach up to 8 files: 20 MB each, 32 MB total, with up to 8 MB of images.",
        );
        continue;
      }
      // Repeated paste/drop of the same selection should not duplicate an upload.
      if (
        [...this.files(), ...accepted].some(
          (f) =>
            f.file.name === file.name &&
            f.file.size === file.size &&
            f.file.lastModified === file.lastModified,
        )
      )
        continue;
      size += file.size;
      if (kind === "image") imageSize += file.size;
      accepted.push({
        ...(snapshot ? { element: snapshot.reference } : {}),
        id: crypto.randomUUID(),
        path: "",
        name: file.name,
        kind,
        size: file.size,
        file,
        status: "uploading",
        progress: 0,
      });
    }
    entry.files.update((current) => [...current, ...accepted]);
    // Sequential files keep binary memory and network work bounded.
    const generation = this.generation;
    for (const file of accepted)
      this.work.push(() => this.upload(file, selection, entry, generation));
    void this.pump();
  }
  remove(id: string): void {
    const request = this.requests.get(id);
    if (request && this.selection)
      this.client.cancel(this.selection.scopeId, request);
    this.requests.delete(id);
    this.entry()?.files.update((files) =>
      files.filter((file) => file.id !== id),
    );
    this.error.set("");
  }
  retry(id: string): void {
    const entry = this.entry(),
      selection = this.selection,
      file = this.files().find((f) => f.id === id);
    if (!entry || !selection || !file || file.status !== "error") return;
    const next = {
      ...file,
      id: crypto.randomUUID(),
      status: "uploading" as const,
      error: undefined,
      progress: 0,
    };
    entry.files.update((files) => files.map((f) => (f.id === id ? next : f)));
    const generation = this.generation;
    this.work.push(() => this.upload(next, selection, entry, generation));
    void this.pump();
  }
  private async pump(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.work.length) await this.work.shift()?.();
    } finally {
      this.working = false;
    }
  }
  private readData(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      this.readers.add(reader);
      const done = () => this.readers.delete(reader);
      reader.onload = () => {
        done();
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new Error("File read failed"));
      };
      reader.onerror = reader.onabort = () => {
        done();
        reject(new Error("File read interrupted"));
      };
      reader.readAsDataURL(blob);
    });
  }
  private async upload(
    file: AttachmentDraft,
    selection: ChatSelection,
    entry: ReturnType<SessionChatDrafts["entry"]>,
    generation: number,
  ): Promise<void> {
    const current = () =>
      generation === this.generation &&
      entry.files().some((f) => f.id === file.id);
    const update = (patch: Partial<AttachmentDraft>) => {
      if (current())
        entry.files.update((files) =>
          files.map((f) => (f.id === file.id ? { ...f, ...patch } : f)),
        );
    };
    try {
      if (file.kind === "image") {
        const preview = await this.readData(file.file);
        update({ preview });
      }
      let offset = 0;
      do {
        if (!current()) return;
        const data =
          (
            await this.readData(file.file.slice(offset, offset + 512 * 1024))
          ).split(",")[1] ?? "";
        if (!current()) return;
        const requestId = crypto.randomUUID();
        this.requests.set(file.id, requestId);
        const result = await this.client.upload(selection.scopeId, {
          ...selection,
          requestId,
          id: file.id,
          name: file.name,
          size: file.file.size,
          offset,
          data,
        });
        this.requests.delete(file.id);
        if (!current()) return;
        if (!result.ok) throw new Error("Upload failed · Retry");
        offset = result.value.offset;
        update({
          progress: file.file.size
            ? Math.round((offset / file.file.size) * 100)
            : 100,
          ...(result.value.path
            ? { path: result.value.path, status: "ready" }
            : {}),
        });
      } while (offset < file.file.size);
    } catch {
      update({ status: "error", error: "Upload failed" });
    }
  }
}
