import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const backend = process.env.VSCODE_E2E_BACKEND_URL || "http://127.0.0.1:11111";
const frontend = process.env.VSCODE_E2E_FRONTEND_URL || "http://127.0.0.1:4205";
let root: string;
test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "elevenex-editor-browser-"));
  await writeFile(path.join(root, "example.ts"), "export const example = 1;\n");
});
test.afterAll(() => rm(root, { recursive: true, force: true }));

async function mount(page: any) {
  await page.goto(frontend);
  const generation = crypto.randomUUID();
  const params = new URLSearchParams({
    generation,
    workspace: `workspace-vfs://elevenex/?${new URLSearchParams({ worktreePath: root, generation })}`,
    extensionPaths: "/vscode-ext1,/vscode-ext2",
    theme: "light",
  });
  await page.evaluate(
    ({ url, generation }: { url: string; generation: string }) => {
      const messages: any[] = ((window as any).__editorMessages = []);
      const iframe = document.createElement("iframe");
      iframe.id = "editor-under-test";
      iframe.dataset.generation = generation;
      iframe.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;z-index:9999";
      window.addEventListener("message", (event) => {
        if (event.source === iframe.contentWindow) messages.push(event.data);
      });
      iframe.addEventListener("load", () =>
        iframe.contentWindow!.postMessage(
          {
            type: "vscode-workbench-check-ready",
            generation: iframe.dataset.generation,
            requestId: "browser-test",
          },
          "*",
        ),
      );
      iframe.src = url;
      document.body.appendChild(iframe);
    },
    { url: `${backend}/vscode-static/index.html?${params}`, generation },
  );
  return generation;
}

async function settled(page: any) {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as any).__editorMessages.find((message: any) =>
            [
              "vscode-workbench-ready",
              "elevenex-editor-startup-error",
              "elevenex-editor-sync-error",
            ].includes(message.type),
          ),
        ),
      { timeout: 35_000 },
    )
    .toBeTruthy();
  return page.evaluate(() =>
    (window as any).__editorMessages
      .filter((message: any) =>
        [
          "vscode-workbench-ready",
          "elevenex-editor-startup-error",
          "elevenex-editor-sync-error",
        ].includes(message.type),
      )
      .at(-1),
  );
}

test("real workbench activates its filesystem bridge and survives state-preserving reattachment", async ({
  page,
}, info) => {
  const consoleMessages: string[] = [];
  page.on("console", (message) => {
    if (consoleMessages.length < 100)
      consoleMessages.push(message.text().slice(0, 1000));
  });
  page.on("pageerror", (error) =>
    consoleMessages.push(error.message.slice(0, 1000)),
  );
  const started = Date.now();
  let navigations = 0;
  page.on("request", (request) => {
    if (request.url().includes("/workbench.html?")) navigations++;
  });
  const generation = await mount(page);
  const result = await settled(page);
  await info.attach("editor-console", {
    body: consoleMessages.join("\n"),
    contentType: "text/plain",
  });
  expect(result).toMatchObject({
    type: "vscode-workbench-ready",
    bridgeReady: true,
    workspaceReady: true,
  });
  console.log(
    `Editor startup: ${Date.now() - started}ms; workers=${page.workers().length}`,
  );
  await page.evaluate((generation) => {
    document
      .querySelector<HTMLIFrameElement>("#editor-under-test")!
      .contentWindow!.postMessage(
        { type: "elevenex-open-file", path: "example.ts", generation },
        "*",
      );
  }, generation);
  const editor = page
    .frameLocator("#editor-under-test")
    .locator(".monaco-editor textarea")
    .first();
  await editor.waitFor();
  await editor.press("ControlOrMeta+End");
  await editor.press("End");
  await editor.press("Space");
  await editor.press("Slash");
  const beforeMove = navigations;
  await page.evaluate(() => {
    const iframe =
      document.querySelector<HTMLIFrameElement>("#editor-under-test")!;
    const context = iframe.contentWindow;
    const parking = document.createElement("div");
    document.body.appendChild(parking);
    if (!("moveBefore" in parking))
      throw new Error("Browser does not support state-preserving moves");
    (parking as any).moveBefore(iframe, null);
    (document.body as any).moveBefore(iframe, null);
    if (iframe.contentWindow !== context)
      throw new Error("Browsing context was recreated");
    iframe.contentWindow!.postMessage(
      {
        type: "elevenex-editor-check",
        requestId: "dirty-after-move",
        save: false,
      },
      "*",
    );
    iframe.contentWindow!.postMessage(
      { type: "elevenex-editor-theme", isDark: true },
      "*",
    );
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__editorMessages.find(
            (message: any) => message.requestId === "dirty-after-move",
          )?.dirty,
      ),
    )
    .toBe(1);
  await expect(
    page.frameLocator("#editor-under-test").locator(".monaco-workbench"),
  ).toHaveClass(/vs-dark/);
  expect(navigations).toBe(beforeMove);
});

test("missing extension assets reach a finite recovery state", async ({
  page,
}) => {
  let unavailable = true;
  await page.route("**/vscode-ext1/**", (route) =>
    unavailable ? route.abort() : route.continue(),
  );
  await mount(page);
  expect((await settled(page)).type).toMatch(/error$/);
  unavailable = false;
  await page.evaluate(() => {
    (window as any).__editorMessages.length = 0;
    const iframe =
      document.querySelector<HTMLIFrameElement>("#editor-under-test")!;
    const generation = crypto.randomUUID();
    iframe.dataset.generation = generation;
    const url = new URL(iframe.src);
    url.searchParams.set("generation", generation);
    const workspace = new URL(url.searchParams.get("workspace")!);
    workspace.searchParams.set("generation", generation);
    url.searchParams.set("workspace", workspace.toString());
    iframe.src = url.toString();
  });
  expect((await settled(page)).type).toBe("vscode-workbench-ready");
});
