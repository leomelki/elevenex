import { FileStatus, BackendGitContentResponse } from "./types";

export class BackendGitClient {
  private controllers = new Set<AbortController>();
  private status?: Promise<FileStatus[]>;
  constructor(
    private baseUrl = `${globalThis.location?.origin ?? "http://localhost:3000"}/api`,
    private worktreePath: string,
  ) {}
  cancel(): void {
    for (const controller of this.controllers) controller.abort();
  }
  dispose(): void {
    this.cancel();
  }

  private async request<T>(
    route: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.controllers.size >= 32)
      throw new Error("Git editor requests are busy");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.controllers.add(controller);
    let rejectAbort!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort(new Error("Git editor request cancelled or timed out"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(abort, 15_000);
    try {
      if (signal?.aborted) throw new Error("Git editor request cancelled");
      return await Promise.race([
        (async () => {
          const query = new URLSearchParams({
            worktreePath: this.worktreePath,
            ...params,
          });
          const response = await fetch(
            `${this.baseUrl}/git/${route}?${query}`,
            { signal: controller.signal },
          );
          if (!response.ok)
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          return response.json() as Promise<T>;
        })(),
        cancelled,
      ]);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  getStatus(): Promise<FileStatus[]> {
    if (!this.status)
      this.status = this.request<FileStatus[]>("editor-status", {}).finally(
        () => {
          this.status = undefined;
        },
      );
    return this.status;
  }
  async getOriginalContent(
    ref: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return (
      await this.request<BackendGitContentResponse>(
        "original",
        { ref, path },
        signal,
      )
    ).content;
  }
}
