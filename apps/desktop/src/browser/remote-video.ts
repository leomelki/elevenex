import { randomUUID } from "node:crypto";
import type { TaskBrowserFrame } from "@elevenex/shared";
import { record } from "./validation";

type VideoFrame = Omit<
  TaskBrowserFrame,
  "scopeId" | "taskId" | "tabId" | "streamId"
>;
interface Subscription {
  readonly tabId: string;
  readonly id: string;
  readonly queue: VideoFrame[];
  readonly window: number;
  sequence: number;
  epoch: string;
  resolve?: (frame: VideoFrame | null) => void;
}

/** Main-owned bounded video receiver. Never discard a dependent access unit. */
export class RemoteBrowserVideo {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly failed = new Set<string>();
  constructor(private readonly request: (body: unknown) => Promise<unknown>, private readonly notify?: (body: unknown) => void) {}
  available(key: string): boolean {
    return !this.failed.has(key);
  }
  fallback(key: string): void {
    // Presentation identities change repeatedly as tabs detach and return.
    if (this.failed.size >= 32)
      this.failed.delete(this.failed.values().next().value ?? "");
    this.failed.add(key);
    this.cancel(key);
  }
  async next(
    tabId: string,
    after: number,
    key: string,
    maximumWindow = 3,
  ): Promise<VideoFrame | null> {
    let entry = this.subscriptions.get(key);
    if (!entry) {
      entry = { tabId, id: randomUUID(), queue: [], sequence: 0, epoch: "", window: maximumWindow === 8 ? 8 : 3 };
      this.subscriptions.set(key, entry);
      const id = entry.id;
      void this.request({
        tabId,
        subscription: id,
        action: "start",
        sequence: 0,
        ...(entry.window === 8 ? { maxInFlight: 8 } : {}),
      }).catch(() => this.end(id));
    } else if (entry.tabId !== tabId || entry.resolve)
      throw new Error("Invalid video presentation");
    if (after > 0) {
      const id = entry.id;
      const body = {
        tabId,
        subscription: id,
        action: "ack",
        sequence: after,
      };
      if (entry.window === 8 && this.notify) this.notify({ ...body, oneWay: true });
      else void this.request(body).catch(() => this.end(id));
    }
    const frame = entry.queue.shift();
    if (frame) return frame;
    return new Promise((resolve) => {
      entry.resolve = resolve;
    });
  }
  receive(header: Record<string, unknown>, data: Uint8Array): void {
    const entry = [...this.subscriptions.values()].find(
      (item) => item.id === header["subscription"],
    );
    if (!entry) return; // A stopped presentation may still have packets on the wire.
    const video = record(header["video"]);
    if (
      header["tabId"] !== entry.tabId ||
      header["sequence"] !== entry.sequence + 1 ||
      typeof video["epoch"] !== "string" ||
      !/^[a-f0-9-]{36}$/.test(video["epoch"]) ||
      video["codec"] !== "avc1.42E02A" ||
      typeof video["key"] !== "boolean" ||
      !Number.isSafeInteger(video["timestamp"]) ||
      Number(video["timestamp"]) < 0 ||
      (entry.epoch !== video["epoch"] && !video["key"]) ||
      entry.queue.length >= entry.window
    )
      throw new Error("Invalid browser video");
    entry.sequence++;
    entry.epoch = video["epoch"];
    const frame: VideoFrame = {
      sequence: entry.sequence,
      width: Number(header["width"]),
      height: Number(header["height"]),
      jpeg: new Uint8Array(),
      video: {
        epoch: entry.epoch,
        codec: "avc1.42E02A",
        key: video["key"],
        timestamp: Number(video["timestamp"]),
        data,
      },
    };
    if (entry.resolve) {
      const resolve = entry.resolve;
      entry.resolve = undefined;
      resolve(frame);
    } else entry.queue.push(frame);
  }
  end(id: unknown): void {
    for (const [key, entry] of this.subscriptions)
      if (entry.id === id) {
        this.fallback(key);
      }
  }
  cancel(key: string, notify = true): void {
    const entry = this.subscriptions.get(key);
    if (!entry) return;
    this.subscriptions.delete(key);
    entry.resolve?.(null);
    if (notify) {
      const body = {
        tabId: entry.tabId,
        subscription: entry.id,
        action: "stop",
        sequence: 0,
      };
      if (entry.window === 8 && this.notify) { try { this.notify({ ...body, oneWay: true }); } catch { /* Closing transport. */ } }
      else void this.request(body).catch(() => undefined);
    }
  }
  destroy(): void {
    for (const key of this.subscriptions.keys()) this.cancel(key, false);
    this.failed.clear();
  }
}
