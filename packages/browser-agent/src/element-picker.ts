import { selectionFingerprintExpression } from "./element-selection.js";
import { object } from "./host.js";
import type { BrowserHumanElement } from "@elevenex/shared";
import { type BrowserAgentTarget } from "./host.js";
import { PlaywrightWorkerClient } from "./playwright-worker-client.js";

/** Created only by a trusted viewer gesture; no code-realm opcode reaches this
 * entry point. The main thread retains the document/ownership predicate. */
export async function pickBrowserElement(
  target: BrowserAgentTarget,
  x: number,
  y: number,
  documentId: string,
  current: () => boolean,
  version = "140.0.0.0",
  capture = true,
): Promise<BrowserHumanElement> {
  let worker: PlaywrightWorkerClient | undefined;
  try {
    const fingerprint = capture
      ? object(
          object(
            await target.send("Runtime.evaluate", {
              expression: selectionFingerprintExpression(x, y),
              returnByValue: true,
            }),
          )["result"],
        )["value"]
      : undefined;
    if (!current()) throw new Error("Element selection changed");
    worker = new PlaywrightWorkerClient(
      {
        list: () => [{ id: target.id, owned: current() }],
        get: () => Promise.resolve(target),
        open: () => Promise.reject(new Error("Inspection cannot open pages")),
      },
      1,
    );
    const selection = await worker.inspect(
      { tabId: target.id, x, y, documentId, version, capture, fingerprint },
      AbortSignal.timeout(15000),
    );
    if (!current()) throw new Error("Element selection changed");
    return selection as BrowserHumanElement;
  } finally {
    worker?.dispose();
    await target.dispose?.();
  }
}

export { validateBrowserSelection } from "./element-selection.js";

export async function validatePickedBrowserElement(
  target: BrowserAgentTarget,
  selection: BrowserHumanElement,
  current: () => boolean,
  version = "140.0.0.0",
): Promise<void> {
  const worker = new PlaywrightWorkerClient(
    {
      list: () => [{ id: target.id, owned: current() }],
      get: () => Promise.resolve(target),
      open: () => Promise.reject(new Error("Inspection cannot open pages")),
    },
    1,
  );
  try {
    await worker.inspect(
      { tabId: target.id, selection, version },
      AbortSignal.timeout(15000),
    );
    if (!current()) throw new Error("Selection changed");
  } finally {
    worker.dispose();
  }
}
