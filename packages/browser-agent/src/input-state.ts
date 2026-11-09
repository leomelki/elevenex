/** Tracks only agent-held native input. The page owner invokes release on
 * takeover, reset and destruction; release never sends a new press. */
export class AgentInputState {
  private readonly keys = new Map<string, Record<string, unknown>>();
  private readonly buttons = new Map<string, Record<string, unknown>>();
  constructor(
    private readonly send: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {}
  record(method: string, params: Record<string, unknown>): void {
    if (method === "Input.dispatchKeyEvent") {
      const key = String(
        params["code"] ??
          params["key"] ??
          params["windowsVirtualKeyCode"] ??
          "",
      );
      if (params["type"] === "keyUp") this.keys.delete(key);
      else if (
        params["type"] === "keyDown" ||
        params["type"] === "rawKeyDown"
      ) {
        if (this.keys.size >= 128 && !this.keys.has(key))
          throw new Error("Agent held-key limit reached");
        this.keys.set(key, { ...params, type: "keyUp", text: undefined });
      }
    } else if (method === "Input.dispatchMouseEvent") {
      const button = String(params["button"] ?? "left");
      if (params["type"] === "mouseReleased") this.buttons.delete(button);
      else if (params["type"] === "mousePressed")
        this.buttons.set(button, { ...params, type: "mouseReleased" });
    }
  }
  release(): void {
    for (const params of this.keys.values())
      void this.send("Input.dispatchKeyEvent", params).catch(() => undefined);
    for (const params of this.buttons.values())
      void this.send("Input.dispatchMouseEvent", params).catch(() => undefined);
    this.keys.clear();
    this.buttons.clear();
  }
}
