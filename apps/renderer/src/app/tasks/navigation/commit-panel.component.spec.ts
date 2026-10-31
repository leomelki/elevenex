import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitPanelComponent } from "./commit-panel.component";
import { TaskGroupComponent } from "../outline/task-group.component";
import { TaskHeaderComponent } from "../lifecycle/task-header.component";
import type { CommitFile, CommitFileWindow } from "./commit-panel.models";
import { MorphFromMotion } from "../../ui";

const files: readonly CommitFile[] = [
  {
    path: ".env.local",
    status: "A",
    add: 9,
    del: 0,
    staged: false,
    flag: "secrets",
  },
  ...Array.from({ length: 10 }, (_, index) => ({
    path: `src/file-${index}.ts`,
    status: "M",
    add: 100 - index,
    del: index,
    staged: index < 2,
  })),
];
beforeEach(() =>
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })),
);
afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
});
function panel() {
  const fixture = TestBed.createComponent(CommitPanelComponent);
  fixture.componentRef.setInput("files", files);
  fixture.componentRef.setInput("open", true);
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement };
}
describe("commit panel public behavior", () => {
  it("hides the completed exit before cancelling its filled animation and can open again", async () => {
    let finish!: (completed: boolean) => void;
    const closing = new Promise<boolean>((resolve) => { finish = resolve; });
    const retarget = vi.spyOn(MorphFromMotion.prototype, "retarget")
      .mockImplementation((open) => open ? Promise.resolve(true) : closing);
    const { fixture, root } = panel();
    const dispose = vi.spyOn(MorphFromMotion.prototype, "dispose")
      .mockImplementation(() => {
        expect(root.querySelector<HTMLElement>(".commit-layer")?.style.visibility).toBe("hidden");
      });
    try {
      TestBed.tick();
      fixture.componentRef.setInput("open", false);
      fixture.detectChanges(); TestBed.tick();
      const layer = root.querySelector<HTMLElement>(".commit-layer")!;
      expect(layer.hasAttribute("inert")).toBe(true);
      finish(true);
      await Promise.resolve(); await Promise.resolve();
      expect(dispose).toHaveBeenCalledOnce();
      fixture.detectChanges(); TestBed.tick();
      expect(root.querySelector(".commit-layer")).toBeNull();
      fixture.componentRef.setInput("open", true);
      fixture.detectChanges(); TestBed.tick();
      expect(root.querySelector<HTMLElement>(".commit-layer")?.style.visibility).toBe("visible");
    } finally {
      retarget.mockRestore(); dispose.mockRestore();
    }
  });

  it("opens and accepts a message before the file check completes, then enables submission", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: CommitFileWindow) => void;
      const provider = vi.fn(() => new Promise<CommitFileWindow>((done) => { resolve = done; }));
      const fixture = TestBed.createComponent(CommitPanelComponent);
      fixture.componentRef.setInput("fileProvider", provider);
      fixture.componentRef.setInput("open", true);
      fixture.detectChanges();
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      TestBed.tick();
      const root = fixture.nativeElement as HTMLElement;
      const layer = root.querySelector<HTMLElement>(".commit-layer")!;
      expect(layer.getAttribute("aria-hidden")).toBe("false");
      expect(layer.hasAttribute("inert")).toBe(false);
      expect(getComputedStyle(layer).visibility).toBe("visible");
      expect(root.querySelector<HTMLButtonElement>("footer button[exButton]")!.disabled).toBe(true);
      const message = root.querySelector<HTMLInputElement>(".message input")!;
      message.value = "Keep the menu responsive";
      message.dispatchEvent(new Event("input"));
      const commit = vi.fn();
      fixture.componentInstance.commitRequested.subscribe(commit);
      message.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(commit).not.toHaveBeenCalled();
      resolve({
        revision: "checked-revision", items: [files[1]!], nextCursor: null,
        matches: 1, total: 1, unstaged: 0,
        selected: { files: 1, add: 100, del: 0, staged: 1, unstaged: 0 }, running: [],
      });
      await Promise.resolve();
      fixture.detectChanges();
      TestBed.tick();
      expect(root.querySelector(".message input")).toBe(message);
      expect(message.value).toBe("Keep the menu responsive");
      const submit = root.querySelector<HTMLButtonElement>("footer button[exButton]")!;
      expect(submit.disabled).toBe(false);
      submit.click();
      expect(commit).toHaveBeenCalledWith(expect.objectContaining({ message: message.value, revision: "checked-revision" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes during the initial file check and ignores its late failure", async () => {
    vi.useFakeTimers();
    try {
      let reject!: (reason: Error) => void;
      let signal!: AbortSignal;
      const fixture = TestBed.createComponent(CommitPanelComponent);
      fixture.componentRef.setInput("fileProvider", (_query: unknown, abort: AbortSignal) => {
        signal = abort;
        return new Promise<CommitFileWindow>((_resolve, fail) => { reject = fail; });
      });
      fixture.componentRef.setInput("open", true);
      fixture.detectChanges();
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      const close = vi.fn(() => fixture.componentRef.setInput("open", false));
      fixture.componentInstance.closeRequested.subscribe(close);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      fixture.detectChanges();
      TestBed.tick();
      expect(close).toHaveBeenCalledOnce();
      expect(signal.aborted).toBe(true);
      reject(new Error("Late file check failure"));
      await Promise.resolve();
      fixture.detectChanges();
      TestBed.tick();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector("[role=alert]")).toBeNull();
      expect(root.querySelector('.commit-layer[aria-hidden="false"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to all safe files, keeps the list folded, and commits an empty optional message", () => {
    const { fixture, root } = panel();
    const commit = vi.fn();
    fixture.componentInstance.commitRequested.subscribe(commit);
    expect(root.querySelector(".summary")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(
      root.querySelector<HTMLInputElement>(".message input")?.placeholder,
    ).toBe("Describe the change, or leave it to Elevenex");
    root
      .querySelector<HTMLInputElement>(".message input")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]![0]).toMatchObject({
      message: "",
      files: files.slice(1).map((file) => file.path),
      push: false,
    });
  });
  it("shows secrets first and four largest changes, then searches every file and honors staged-only", () => {
    const { fixture, root } = panel();
    root.querySelector<HTMLButtonElement>(".summary")!.click();
    fixture.detectChanges();
    expect(root.querySelectorAll(".file").length).toBe(5);
    expect(root.querySelector(".file")?.textContent).toContain(".env.local");
    const search = root.querySelector<HTMLInputElement>(".filter input")!;
    search.value = "file-9";
    search.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    expect(root.querySelectorAll(".file").length).toBe(1);
    expect(root.querySelector(".file")?.textContent).toContain("file-9");
    root.querySelector<HTMLInputElement>(".option input")!.click();
    fixture.detectChanges();
    expect(root.querySelector<HTMLInputElement>(".file input")!.disabled).toBe(
      true,
    );
    expect(root.querySelector("footer")?.textContent).toContain("Commit 2");
  });
  it("requires explicit secret inclusion and ignores Enter during IME composition", () => {
    const { fixture, root } = panel();
    const commit = vi.fn();
    fixture.componentInstance.commitRequested.subscribe(commit);
    root.querySelector<HTMLButtonElement>(".note .inline")!.click();
    fixture.detectChanges();
    expect(root.querySelector(".note")?.textContent).toContain("Leave it out");
    root
      .querySelector("input")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
        }),
      );
    expect(commit).not.toHaveBeenCalled();
    root
      .querySelector("section")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
        }),
      );
    expect(commit.mock.calls[0]![0].files).toContain(".env.local");
  });
  it("aborts obsolete file queries and releases the active query on destruction", async () => {
    vi.useFakeTimers();
    try {
      const { fixture, root } = panel();
      const signals: AbortSignal[] = [];
      const provider = vi.fn((_query, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<never>(() => {});
      });
      fixture.componentRef.setInput("fileProvider", provider);
      fixture.detectChanges();
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(100);
      const search = root.querySelector<HTMLInputElement>(".filter input")!;
      search.value = "new";
      search.dispatchEvent(new Event("input"));
      fixture.detectChanges();
      TestBed.tick();
      expect(signals[0]!.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(provider).toHaveBeenCalledTimes(2);
      fixture.destroy();
      expect(signals[1]!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
it("keeps Close task the same size and identity when suggested", () => {
  const fixture = TestBed.createComponent(TaskHeaderComponent);
  fixture.componentRef.setInput("title", "Task");
  fixture.detectChanges();
  const button = fixture.nativeElement.querySelector(".close-task");
  expect(button.textContent).toContain("Close task");
  fixture.componentRef.setInput("closeSuggested", true);
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelector(".close-task")).toBe(button);
  expect(button.classList.contains("suggested")).toBe(true);
});
it("keeps the task header creation action when selecting a nested session", () => {
  const fixture = TestBed.createComponent(TaskGroupComponent);
  fixture.componentRef.setInput("task", {
    id: "task",
    title: "Task",
    sessions: [],
    subtasks: [
      {
        id: "sub",
        title: "Sub",
        sessions: [{ id: "selected", title: "Session", status: "running" }],
      },
    ],
  });
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const button = root.querySelector<HTMLButtonElement>('header .add button')!;
  fixture.componentRef.setInput("selected", "selected");
  fixture.detectChanges();
  expect(root.querySelector("article.current")).not.toBeNull();
  expect(root.querySelector('header .add button')).toBe(button);
  expect(button.getAttribute('aria-label')).toBe('New session in this task');
  expect(root.querySelector('.tree')?.textContent).not.toContain('New session');
  const add = vi.fn();
  fixture.componentInstance.addSession.subscribe(add);
  button.click();
  expect(add).toHaveBeenCalledWith("task");
  fixture.componentRef.setInput("filter", "running");
  fixture.detectChanges();
  expect(root.querySelector('header .add button')).toBe(button);
  expect(root.querySelector('.tree')?.textContent).not.toContain('New session');
});

it('summarizes multiple running sessions in one note without attributing files', () => {
  const {fixture, root} = panel(); fixture.componentRef.setInput('running', ['First', 'Second']); fixture.detectChanges();
  expect(root.textContent).toContain('2 sessions');
  expect(root.textContent).toContain('What they change from now on');
  expect(root.textContent).not.toContain('First is still running');
});
