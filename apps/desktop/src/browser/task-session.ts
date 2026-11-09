import { createHash } from "node:crypto";
import { session, type Session, type DownloadItem } from "electron";

/** Application-owned leases prevent competing windows from replacing a profile's network policy. */
export class BrowserTaskProfiles {
  private readonly active = new Set<string>();
  private readonly closing = new Map<string, Promise<void>>();
  acquire(partition: string): Promise<void> {
    if (this.active.has(partition)) throw new Error("This task browser is open in another window. Close the other window before opening it here.");
    this.active.add(partition);
    return this.closing.get(partition) ?? Promise.resolve();
  }
  release(partition: string, cleanup: Promise<void>): void {
    this.active.delete(partition);
    this.closing.set(partition, cleanup);
    void cleanup.finally(() => {
      if (this.closing.get(partition) === cleanup) this.closing.delete(partition);
    });
  }
  async flush(): Promise<void> { await Promise.all(this.closing.values()); }
}

/** Chromium owns durable site data; application metadata never contains cookies or storage. */
export class BrowserTaskSession {
  readonly partition: string;
  readonly session: Session;
  private readonly previous: Promise<void>;
  private pending?: Promise<void>;
  private disposed = false;
  private readonly downloads = new Set<DownloadItem>();
  constructor(
    identity: string,
    private readonly profiles: BrowserTaskProfiles,
    private readonly configureNetwork: (session: Session) => Promise<void>,
    allowed: (url: string) => boolean,
    observe: (contentsId: number) => void,
    canDownload: (contentsId: number) => boolean,
    notify: (contentsId: number, message: string, outside?: boolean) => void,
    agentDownload?: (contentsId: number, item: DownloadItem) => boolean,
  ) {
    this.partition = "persist:task-browser-" + createHash("sha256").update(identity).digest("hex");
    this.previous = profiles.acquire(this.partition);
    this.session = session.fromPartition(this.partition);
    this.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    this.session.setPermissionCheckHandler(() => false);
    this.session.on("will-download", (event, item, contents) => {
      const contentsId = contents.id;
      if (this.downloads.size < 2 && agentDownload?.(contentsId, item)) { this.downloads.add(item); item.once('done', () => this.downloads.delete(item)); return; }
      if (!canDownload(contentsId) || this.downloads.size >= 2) {
        event.preventDefault();
        return;
      }
      this.downloads.add(item);
      const name =
        [...item.getFilename()]
          .map((character) => {
            const code = character.charCodeAt(0);
            return code < 32 ||
              "/\\:".includes(character) ||
              (code >= 0x202a && code <= 0x202e) ||
              (code >= 0x2066 && code <= 0x2069)
              ? "_"
              : character;
          })
          .join("")
          .slice(0, 200) || "download";
      let oversized = false;
      item.setSaveDialogOptions({ title: "Save download", defaultPath: name });
      item.on("updated", () => {
        if (
          item.getReceivedBytes() > 32_000_000 ||
          item.getTotalBytes() > 32_000_000
        ) {
          oversized = true;
          item.cancel();
        }
      });
      item.once("done", (_event, state) => {
        this.downloads.delete(item);
        if (this.disposed) return;
        if (oversized)
          notify(
            contentsId,
            "This download exceeded the 32 MB limit. Use Open outside for larger files.",
            true,
          );
        else if (state === "completed") notify(contentsId, "Download saved: " + name);
        else if (state === "interrupted")
          notify(
            contentsId,
            "Download stopped. Check the connection or download it outside.",
            true,
          );
      });
    });
    this.session.webRequest.onBeforeRequest((details, callback) => {
      try {
        callback({
          cancel:
            this.disposed ||
            !["http:", "https:", "ws:", "wss:", "data:", "blob:"].includes(
              new URL(details.url).protocol,
            ) ||
            !allowed(details.url),
        });
      } catch {
        callback({ cancel: true });
      }
    });
    this.session.webRequest.onErrorOccurred((details) => {
      if (details.error !== "net::ERR_ABORTED")
        observe(details.webContentsId ?? -1);
    });
    this.session.webRequest.onCompleted((details) => {
      if (details.statusCode >= 400) observe(details.webContentsId ?? -1);
    });
  }
  configure(): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error("Task browser profile closed"));
    return (this.pending ??= this.previous.then(() => {
      if (this.disposed) throw new Error("Task browser profile closed");
      return this.configureNetwork(this.session);
    }).catch(
      (error) => {
        this.pending = undefined;
        throw error;
      },
    ));
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.downloads) item.cancel();
    this.downloads.clear();
    // Detach synchronously: a new owner may reuse this Session before disk flush completes.
    this.session.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    this.session.webRequest.onErrorOccurred(null);
    this.session.webRequest.onCompleted(null);
    this.session.removeAllListeners("will-download");
    const cleanup = this.previous.then(async () => {
      await this.pending?.catch(() => undefined);
      this.session.flushStorageData();
      await Promise.allSettled([this.session.cookies.flushStore(), this.session.closeAllConnections()]);
    });
    this.profiles.release(this.partition, cleanup);
  }
}
