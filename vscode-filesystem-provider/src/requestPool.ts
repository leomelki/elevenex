/** Finite HTTP work, including body consumption and queued time. */
export class RequestPool {
  private active = 0;
  private pending: Array<() => void> = [];
  private controllers = new Set<AbortController>();
  cancel(): void {
    for (const controller of this.controllers) controller.abort();
  }
  dispose(): void {
    this.cancel();
  }

  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) controller.abort();
    this.controllers.add(controller);
    const timer = setTimeout(abort, 15_000);
    let release: (() => void) | undefined;
    let removeQueued: (() => void) | undefined;
    let complete = false;
    let rejectAbort!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      removeQueued?.();
      cleanup();
      rejectAbort(
        new Error(
          "Editor request cancelled or timed out. Retry the connection.",
        ),
      );
    };
    const cleanup = () => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
      this.controllers.delete(controller);
      release?.();
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const releaseSlot = () => {
      const next = this.pending.shift();
      if (next) next();
      else this.active--;
    };
    try {
      if (controller.signal.aborted)
        throw new Error("Editor request cancelled");
      if (this.active >= 8) {
        if (this.pending.length >= 64)
          throw new Error("Too many editor requests. Retry shortly.");
        let start!: () => void;
        const turn = new Promise<void>((resolve) => {
          start = () => {
            removeQueued = undefined;
            release = releaseSlot;
            resolve();
          };
          removeQueued = () => {
            this.pending = this.pending.filter((item) => item !== start);
          };
          this.pending.push(start);
        });
        await Promise.race([turn, cancelled]);
      } else {
        this.active++;
        release = releaseSlot;
      }
      if (controller.signal.aborted)
        throw new Error("Editor request cancelled");
      const response = await Promise.race([
        fetch(input, { ...init, signal: controller.signal }),
        cancelled,
      ]);
      if (!response.ok || (init.method && init.method !== "GET")) {
        cleanup();
        return response;
      }
      for (const method of ["json", "arrayBuffer"] as const) {
        if (!response[method]) continue;
        const original = response[method].bind(response);
        response[method] = (async () => {
          try {
            return await Promise.race([original(), cancelled]);
          } finally {
            cleanup();
          }
        }) as (typeof response)[typeof method];
      }
      // A streaming response owns its slot until EOF/cancel. Its underlying
      // fetch receives the same abort signal, so deadline interrupts reader.read.
      if (response.body?.getReader) {
        const reader = response.body.getReader.bind(response.body);
        response.body.getReader = (() => {
          const streamReader = reader();
          const read = streamReader.read.bind(streamReader);
          const cancel = streamReader.cancel.bind(streamReader);
          streamReader.read = async () => {
            try {
              const result = await Promise.race([read(), cancelled]);
              if (result.done) cleanup();
              return result;
            } catch (error) {
              cleanup();
              throw error;
            }
          };
          streamReader.cancel = async (reason) => {
            try {
              await cancel(reason);
            } finally {
              cleanup();
            }
          };
          return streamReader;
        }) as typeof response.body.getReader;
      }
      void cancelled.catch(() => cleanup());
      return response;
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}
