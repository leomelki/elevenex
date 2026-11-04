import { randomUUID } from "node:crypto";
import { session, type Session, type DownloadItem } from "electron";

/** One nonpersistent task profile, shared by its tabs and isolated from other tasks/windows. */
export class BrowserTaskSession {
  readonly partition = "task-browser-" + randomUUID();
  readonly session: Session;
  private pending?: Promise<void>;
  private disposed = false;
  private readonly downloads = new Set<DownloadItem>();
  constructor(
    private readonly configureNetwork: (session: Session) => Promise<void>,
    allowed: (url: string) => boolean,
    observe: (contentsId: number) => void,
    canDownload: (contentsId: number) => boolean,
    notify: (contentsId: number, message: string, outside?: boolean) => void,
  ) {
    this.session = session.fromPartition(this.partition);
    this.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    this.session.setPermissionCheckHandler(() => false);
    this.session.on("will-download", (event, item, contents) => {
      const contentsId = contents.id;
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
    return (this.pending ??= this.configureNetwork(this.session).catch(
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
    void Promise.allSettled([
      this.session.clearStorageData(),
      this.session.closeAllConnections(),
    ]).finally(() => {
      this.session.webRequest.onBeforeRequest(null);
      this.session.webRequest.onErrorOccurred(null);
      this.session.webRequest.onCompleted(null);
      this.session.removeAllListeners();
    });
  }
}
