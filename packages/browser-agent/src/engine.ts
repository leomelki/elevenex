import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type {
  BrowserCodeCommand,
  BrowserCodeImage,
  BrowserCodeResult,
} from "@elevenex/shared";
import { BrowserAgentBroker } from "./broker.js";
import { object, type BrowserAgentHost } from "./host.js";
import { BOOTSTRAP, WORKER_SOURCE } from "./worker-source.js";

class Sandbox {
  readonly id = randomUUID();
  private readonly worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { bootstrap: BOOTSTRAP },
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  });
  private active?: { fail(message: string): void };
  private stopped = false;
  private idle?: ReturnType<typeof setTimeout>;
  private readonly broker: BrowserAgentBroker;
  constructor(
    host: BrowserAgentHost,
    sessionId: number,
    private readonly retire: () => void,
  ) {
    this.broker = new BrowserAgentBroker(host, sessionId);
    this.worker.on("error", (error: unknown) => {
      this.active?.fail(
        error instanceof Error ? error.message : "Browser worker failed",
      );
      this.dispose();
    });
    this.worker.on("exit", () => {
      this.active?.fail("Browser code worker stopped");
      this.dispose();
    });
  }
  get busy(): boolean {
    return !!this.active;
  }
  run(
    command: BrowserCodeCommand,
    signal: AbortSignal,
  ): Promise<BrowserCodeResult> {
    if (this.active)
      return Promise.reject(
        new Error(
          "Browser code already running for this session; await it before another call",
        ),
      );
    if (this.stopped)
      return Promise.reject(
        new Error("Sandbox stopped; call browser_run again"),
      );
    clearTimeout(this.idle);
    const controller = new AbortController(),
      images: BrowserCodeImage[] = [],
      logs: string[] = [];
    let operations = 0,
      inFlight = 0,
      output = 0;
    return new Promise((resolve) => {
      const finish = (
        value: unknown,
        error?: BrowserCodeResult["error"],
        reset = false,
      ) => {
        if (this.active !== active) return;
        this.active = undefined;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.worker.removeListener("message", message);
        controller.abort();
        if (reset) {
          this.broker.interrupt();
          this.dispose();
        } else {
          this.idle = setTimeout(() => this.dispose(), 300000);
          this.idle.unref();
        }
        resolve({
          sandboxId: this.id,
          value,
          logs,
          images,
          ...(error ? { error } : {}),
        });
      };
      const fail = (message: string) =>
        finish(null, { message, outcomeUnknown: true }, true);
      const active = { fail };
      const abort = () =>
        fail(
          "Browser execution cancelled. Accepted actions may have completed; inspect before retrying. Sandbox reset; tabs remain open.",
        );
      const timer = setTimeout(
        () =>
          fail(
            "Browser execution timed out. Accepted actions may have completed; inspect before retrying. Sandbox reset; tabs remain open.",
          ),
        command.timeoutMs,
      );
      const message = (raw: unknown) => {
        if (this.active !== active) return;
        try {
          const data = object(raw);
          if (data["fatal"]) {
            fail(String(data["fatal"]).slice(0, 2048));
            return;
          }
          if (!Array.isArray(data["queue"]) || !Array.isArray(data["logs"]))
            throw new Error("Invalid browser worker reply");
          for (const log of data["logs"]) {
            if (typeof log !== "string")
              throw new Error("Invalid console output");
            output += log.length;
            if (output > 32000 || logs.length >= 100)
              throw new Error("Console output limit reached");
            logs.push(log);
          }
          for (const rawRpc of data["queue"]) {
            const rpc = object(rawRpc);
            if (
              typeof rpc["id"] !== "number" ||
              typeof rpc["method"] !== "string" ||
              !Array.isArray(rpc["args"]) ||
              ++operations > 512 ||
              ++inFlight > 16
            )
              throw new Error(
                "Browser operation budget exceeded (512 per call, 16 concurrent)",
              );
            void this.broker
              .invoke(rpc["method"], rpc["args"], controller.signal, images)
              .then(
                (value) => reply(rpc["id"], value),
                (error: unknown) =>
                  reply(
                    rpc["id"],
                    null,
                    error instanceof Error ? error.message : String(error),
                  ),
              );
          }
          if (
            data["done"] &&
            data["pending"] === 0 &&
            data["queue"].length === 0 &&
            inFlight === 0
          ) {
            const done = object(data["done"]);
            finish(
              done["value"],
              done["error"]
                ? {
                    message: String(done["error"]).slice(0, 4096),
                    outcomeUnknown: false,
                  }
                : undefined,
            );
          }
        } catch (error) {
          fail(
            error instanceof Error ? error.message : "Browser execution failed",
          );
        }
      };
      const reply = (id: unknown, value: unknown, error?: string) => {
        inFlight--;
        if (this.active !== active || controller.signal.aborted) return;
        try {
          if (Buffer.byteLength(JSON.stringify(value ?? null)) > 1048576) {
            value = null;
            error =
              "Browser reply exceeded 1 MiB; filter in evaluate or use smaller windows";
          }
          this.worker.postMessage({
            type: "reply",
            id,
            value,
            error: error?.slice(0, 4096),
          });
        } catch {
          fail("Browser reply is not serializable");
        }
      };
      this.active = active;
      signal.addEventListener("abort", abort, { once: true });
      this.worker.on("message", message);
      if (signal.aborted) abort();
      else this.worker.postMessage({ type: "run", code: command.code });
    });
  }
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.active?.fail(
      "Browser sandbox reset. Inspect tabs before repeating an interrupted action.",
    );
    clearTimeout(this.idle);
    this.broker.interrupt();
    this.broker.dispose();
    void this.worker.terminate();
    this.retire();
  }
}

/** Task-owned execution: isolated conversation state, bounded warm workers, no mutation replay. */
export class BrowserAgentEngine {
  private readonly sessions = new Map<number, Sandbox>();
  private stopped = false;
  constructor(private readonly host: BrowserAgentHost) {}
  get active(): boolean {
    return [...this.sessions.values()].some((sandbox) => sandbox.busy);
  }
  async execute(
    sessionId: number,
    command: BrowserCodeCommand,
    signal: AbortSignal,
  ): Promise<BrowserCodeResult> {
    signal.throwIfAborted();
    if (this.stopped) throw new Error("Browser task closed");
    if (
      !Number.isSafeInteger(sessionId) ||
      sessionId < 1 ||
      typeof command.code !== "string" ||
      command.code.length > 65536 ||
      !Number.isInteger(command.timeoutMs) ||
      command.timeoutMs < 250 ||
      command.timeoutMs > 60000
    )
      throw new Error("Invalid browser code request");
    let sandbox = this.sessions.get(sessionId);
    if (command.reset) {
      sandbox?.dispose();
      return {
        sandboxId: "",
        value: { reset: true, tabsPreserved: true },
        logs: [],
        images: [],
      };
    }
    if (!sandbox) {
      if (this.sessions.size >= 8)
        throw new Error(
          "Eight browser sandboxes are already active; reset an idle session",
        );
      sandbox = new Sandbox(this.host, sessionId, () => {
        if (this.sessions.get(sessionId) === sandbox)
          this.sessions.delete(sessionId);
      });
      this.sessions.set(sessionId, sandbox);
    }
    return sandbox.run(command, signal);
  }
  dispose(): void {
    this.stopped = true;
    for (const sandbox of this.sessions.values()) sandbox.dispose();
    this.sessions.clear();
  }
}
