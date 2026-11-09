import { randomUUID } from "node:crypto";
import type { BrowserCodeImage } from "@elevenex/shared";
import { integer, object, type BrowserAgentTarget } from "./host.js";

export class AgentTarget {
  readonly handle = randomUUID();
  private document = 0;
  private sequence = 0;
  private readonly history: { seq: number; method: string; params: unknown }[] =
    [];
  private bytes = 0;
  private readonly unsubscribe: () => void;
  private readonly group = "elevenex-agent-" + this.handle;
  signal?: AbortSignal;
  constructor(readonly target: BrowserAgentTarget) {
    this.unsubscribe = target.subscribe((method, params) => {
      try {
        target.assert();
      } catch {
        this.history.length = 0;
        this.bytes = 0;
        return;
      }
      if (
        method === "DOM.documentUpdated" ||
        method === "Runtime.executionContextsCleared"
      )
        this.document++;
      if (
        !/^(Network\.(requestWillBeSent|responseReceived|loadingFailed|loadingFinished)|Runtime\.(consoleAPICalled|exceptionThrown)|Log\.entryAdded|Page\.(frameNavigated|loadEventFired|javascriptDialogOpening))$/u.test(
          method,
        )
      )
        return;
      const text = JSON.stringify(params);
      const item = {
        seq: ++this.sequence,
        method,
        params:
          text.length <= 8192
            ? params
            : { truncated: true, summary: text.slice(0, 2048) },
      };
      this.bytes += JSON.stringify(item).length;
      this.history.push(item);
      while (this.history.length > 256 || this.bytes > 262144)
        this.bytes -= JSON.stringify(this.history.shift()).length;
    });
  }
  async start(): Promise<void> {
    for (const [method, params] of [
      ["Runtime.enable", {}],
      ["DOM.enable", {}],
      ["Page.enable", {}],
      [
        "Network.enable",
        {
          maxTotalBufferSize: 4194304,
          maxResourceBufferSize: 1048576,
          maxPostDataSize: 0,
        },
      ],
      ["Log.enable", {}],
    ] as const)
      await this.send(method, params);
  }
  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.signal?.throwIfAborted();
    this.target.assert();
    const result = await this.target.send(method, params);
    this.signal?.throwIfAborted();
    this.target.assert();
    return result;
  }
  async evaluate(
    source: unknown,
    arg: unknown,
    isFunction: boolean,
  ): Promise<unknown> {
    if (typeof source !== "string" || source.length > 65536)
      throw new Error(
        "evaluate requires a function or expression, up to 64 KiB",
      );
    const expression = isFunction
      ? `(${source})(${JSON.stringify(arg)})`
      : source;
    const result = object(
      await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: 10000,
        objectGroup: this.group,
      }),
    );
    if (result["exceptionDetails"]) {
      const exception = object(result["exceptionDetails"]);
      const description = exception["exception"]
        ? object(exception["exception"])["description"]
        : exception["text"];
      throw new Error(
        String(description ?? "Page evaluation failed").slice(0, 2048),
      );
    }
    const remote = object(result["result"]);
    if (remote["subtype"] === "error")
      throw new Error(String(remote["description"]).slice(0, 2048));
    return remote["value"] ?? remote["unserializableValue"] ?? null;
  }
  async snapshot(options: Record<string, unknown>): Promise<unknown> {
    const maxChars = integer(options["maxChars"], 16000, 256, 64000);
    const result = object(
      await this.send("Accessibility.getFullAXTree", {
        depth: integer(options["depth"], 20, 1, 100),
      }),
    );
    const nodes = result["nodes"];
    if (!Array.isArray(nodes))
      throw new Error("Accessibility tree unavailable");
    const epoch = this.document,
      lines: string[] = [];
    let length = 0,
      truncated = false;
    for (const raw of nodes) {
      const node = object(raw);
      if (node["ignored"]) continue;
      const role = String(
        node["role"] ? (object(node["role"])["value"] ?? "") : "",
      );
      if (
        options["interactive"] === true &&
        !/button|link|textbox|checkbox|radio|combobox|option|slider|spinbutton|menuitem|switch|tab$/iu.test(
          role,
        )
      )
        continue;
      if (["InlineTextBox", "generic", "none"].includes(role)) continue;
      const name = String(
        node["name"] ? (object(node["name"])["value"] ?? "") : "",
      ).slice(0, 240);
      const ref =
        typeof node["backendDOMNodeId"] === "number"
          ? ` [ref=${epoch}:${node["backendDOMNodeId"]}]`
          : "";
      // Values (especially password fields) are deliberately absent; agents can
      // explicitly evaluate their own page if a task requires reading a value.
      const line = `${role} ${JSON.stringify(name)}${ref}`;
      if (length + line.length + 1 > maxChars) {
        truncated = true;
        break;
      }
      lines.push(line);
      length += line.length + 1;
    }
    return { text: lines.join("\n"), truncated, document: epoch };
  }
  private async resolve(target: unknown): Promise<string> {
    if (typeof target !== "string" || target.length > 2048)
      throw new Error("Target must be a CSS selector or snapshot ref");
    let backendNodeId: number;
    if (/^\d+:\d+$/u.test(target)) {
      const [epoch, id] = target.split(":").map(Number);
      if (epoch !== this.document)
        throw new Error("Stale snapshot ref; take a fresh snapshot");
      backendNodeId = id!;
    } else {
      const root = object(object(await this.send("DOM.getDocument"))["root"]);
      const found = object(
        await this.send("DOM.querySelector", {
          nodeId: root["nodeId"],
          selector: target,
        }),
      );
      if (!found["nodeId"])
        throw new Error(
          "No element matches the selector; inspect the page or waitFor it",
        );
      const node = object(
        object(
          await this.send("DOM.describeNode", { nodeId: found["nodeId"] }),
        )["node"],
      );
      backendNodeId = Number(node["backendNodeId"]);
    }
    const resolved = object(
      object(
        await this.send("DOM.resolveNode", {
          backendNodeId,
          objectGroup: this.group,
        }),
      )["object"],
    );
    if (typeof resolved["objectId"] !== "string")
      throw new Error("Element detached; take a fresh snapshot");
    return resolved["objectId"];
  }
  async point(
    target: unknown,
    fill = false,
  ): Promise<{ x: number; y: number }> {
    const objectId = await this.resolve(target);
    try {
      const result = object(
        await this.send("Runtime.callFunctionOn", {
          objectId,
          returnByValue: true,
          functionDeclaration: `function() {
          if (!this.isConnected || this.disabled) throw new Error('Element detached or disabled');
          this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
          const r = this.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2;
          if (!r.width || !r.height || getComputedStyle(this).visibility === 'hidden') throw new Error('Element is not visible');
          const hit = this.getRootNode().elementFromPoint(x,y);
          if (!hit || !(this === hit || this.contains(hit))) throw new Error('Element is covered; inspect the page');
          ${fill ? "this.focus(); if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) { const range=document.createRange(); range.selectNodeContents(this); const s=getSelection(); s.removeAllRanges(); s.addRange(range); } else throw new Error('Element is not editable');" : ""}
          return {x,y};
        }`,
        }),
      );
      if (result["exceptionDetails"])
        throw new Error(
          "Element is detached, hidden, disabled, covered or not editable; inspect the page",
        );
      const point = object(object(result["result"])["value"]);
      return { x: Number(point["x"]), y: Number(point["y"]) };
    } finally {
      await this.send("Runtime.releaseObject", { objectId }).catch(
        () => undefined,
      );
    }
  }
  events(options: Record<string, unknown>): unknown {
    this.target.assert();
    const since = integer(options["since"], 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(options["limit"], 50, 1, 100);
    const method = options["method"];
    if (
      method !== undefined &&
      (typeof method !== "string" || method.length > 100)
    )
      throw new Error("Event method filter must be a string");
    const matching = this.history.filter(
      (item) =>
        item.seq > since && (!method || item.method.includes(String(method))),
    );
    const items = matching.slice(0, limit);
    return {
      items,
      next: items.at(-1)?.seq ?? this.sequence,
      hasMore: matching.length > limit,
      dropped: since < (this.history[0]?.seq ?? 1) - 1,
    };
  }
  async screenshot(options: Record<string, unknown>): Promise<{
    image: BrowserCodeImage;
    clip: Record<string, unknown>;
    scale: number;
    viewport: { width: number; height: number; pageX: number; pageY: number };
  }> {
    const metrics = object(await this.send("Page.getLayoutMetrics"));
    const viewport = object(
      metrics["cssVisualViewport"] ?? metrics["visualViewport"],
    );
    const width = Number(viewport["clientWidth"]),
      height = Number(viewport["clientHeight"]);
    const pageX = Number(viewport["pageX"] ?? 0),
      pageY = Number(viewport["pageY"] ?? 0);
    const clip = options["clip"]
      ? object(options["clip"])
      : { x: pageX, y: pageY, width, height };
    for (const key of ["x", "y", "width", "height"])
      if (typeof clip[key] !== "number" || !Number.isFinite(clip[key]))
        throw new Error(
          "Screenshot clip must contain finite CSS pixel coordinates",
        );
    const w = Number(clip["width"]),
      h = Number(clip["height"]);
    if (
      Number(clip["x"]) < 0 ||
      Number(clip["y"]) < 0 ||
      w <= 0 ||
      h <= 0 ||
      w > 4096 ||
      h > 4096 ||
      w * h > 8_000_000
    )
      throw new Error("Screenshot clip exceeds 4096 px or 8 megapixels");
    const scale = Math.min(1, 1920 / w, 1440 / h);
    const result = object(
      await this.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: integer(options["quality"], 80, 30, 95),
        captureBeyondViewport: options["clip"] !== undefined,
        clip: { ...clip, scale },
        fromSurface: true,
      }),
    );
    if (typeof result["data"] !== "string" || result["data"].length > 2_800_000)
      throw new Error("Screenshot exceeded 2 MiB; crop or reduce quality");
    return {
      image: {
        data: result["data"],
        mimeType: "image/jpeg",
        width: Math.round(w * scale),
        height: Math.round(h * scale),
      },
      clip,
      scale,
      viewport: { width, height, pageX, pageY },
    };
  }
  dispose(): void {
    this.unsubscribe();
    this.history.length = 0;
    void Promise.resolve().then(() => this.target.send('Runtime.releaseObjectGroup', { objectGroup: this.group }))
      .catch(() => undefined).then(() => this.target.dispose?.()).catch(() => undefined);
  }
}
