import { TestBed } from "@angular/core/testing";
import { GitBarComponent } from "./git-bar.component";

describe("GitBar motion ownership", () => {
  const originalAnimate = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "animate",
  );
  const disconnected = vi.fn();
  const mediaRemoved = vi.fn();
  const media = { matches: false };
  let motionChanged: (() => void) | undefined;
  let paintedPrimary: number | undefined;
  let paintedAction: number | undefined;
  const animations: { cancel: ReturnType<typeof vi.fn> }[] = [];
  const animate = vi.fn(function (
    this: HTMLElement,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    const animation = {
      frames,
      options,
      cancel: vi.fn(),
      onfinish: null,
      oncancel: null,
    };
    animations.push(animation);
    return animation;
  });

  beforeEach(() => {
    animations.length = 0;
    animate.mockClear();
    disconnected.mockClear();
    mediaRemoved.mockClear();
    media.matches = false;
    motionChanged = undefined;
    paintedPrimary = undefined;
    paintedAction = undefined;
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return media.matches;
      },
      addEventListener: (_type: string, callback: () => void) => {
        motionChanged = callback;
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      removeEventListener: mediaRemoved,
    }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect = disconnected;
      },
    );
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        let width = parseFloat(this.style.width) || 0;
        if (this.matches(".action-measure"))
          width = this.textContent?.includes("Committing")
            ? 94
            : this.textContent?.includes("Commit")
              ? 120
              : 60;
        if (this.matches(".stat-measure"))
          width = this.textContent?.includes("Up to date") ? 80 : 110;
        if (this.matches(".more")) width = 24;
        if (this.matches(".primary") && paintedPrimary !== undefined)
          width = paintedPrimary;
        if (this.matches(".action-slot") && paintedAction !== undefined)
          width = paintedAction;
        return new DOMRect(0, 0, width, 30);
      },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalAnimate)
      Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  it("retains the closing action and changes its intent immediately while preserving the native button", async () => {
    const fixture = TestBed.createComponent(GitBarComponent);
    fixture.componentRef.setInput("ahead", 2);
    fixture.detectChanges();
    await fixture.whenStable();
    const primary: HTMLButtonElement =
      fixture.nativeElement.querySelector(".primary");
    const actions = vi.fn();
    fixture.componentInstance.action.subscribe(actions);
    expect(animate).not.toHaveBeenCalled();
    primary.click();
    expect(actions).toHaveBeenLastCalledWith("push");

    fixture.componentRef.setInput("ahead", 0);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(primary.textContent).toContain("Push");
    expect(primary.textContent).toContain("2");
    expect(primary.closest("[inert]")).not.toBeNull();
    expect(primary.disabled).toBe(true);

    paintedAction = 70;
    fixture.componentRef.setInput("files", 7);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector(".primary")).toBe(primary);
    expect(primary.getAttribute("aria-label")).toBe("Commit 7");
    expect(primary.closest("[inert]")).toBeNull();
    expect(animate.mock.contexts).toContain(primary);
    primary.click();
    expect(actions).toHaveBeenLastCalledWith("commit");
    fixture.destroy();
  });

  it("retargets from the current painted width, settles reduced motion immediately, and cleans up", async () => {
    const fixture = TestBed.createComponent(GitBarComponent);
    fixture.componentRef.setInput("files", 7);
    fixture.detectChanges();
    await fixture.whenStable();
    const primary: HTMLButtonElement =
      fixture.nativeElement.querySelector(".primary");
    expect(animate).not.toHaveBeenCalled();

    fixture.componentRef.setInput("busy", "commit");
    fixture.detectChanges();
    await fixture.whenStable();
    expect(animate).toHaveBeenCalled();
    paintedPrimary = 103;
    fixture.componentRef.setInput("files", 0);
    fixture.componentRef.setInput("ahead", 3);
    fixture.componentRef.setInput("busy", undefined);
    fixture.detectChanges();
    await fixture.whenStable();
    const primaryCalls = animate.mock.calls.filter(
      (_call, index) => animate.mock.contexts[index] === primary,
    );
    expect(primaryCalls.at(-1)?.[0][0]).toEqual({ width: "103px" });
    expect(primary.getAttribute("aria-label")).toBe("Push 3");

    const calls = animate.mock.calls.length;
    media.matches = true;
    motionChanged?.();
    fixture.componentRef.setInput("files", 128);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(animate).toHaveBeenCalledTimes(calls);
    expect(primary.getAttribute("aria-label")).toBe("Commit 128");
    fixture.destroy();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(mediaRemoved).toHaveBeenCalledWith("change", expect.any(Function));
    for (const animation of animations)
      expect(animation.cancel).toHaveBeenCalled();
  });

  it("commits then merges a sub-task through the same persistent button", async () => {
    const fixture = TestBed.createComponent(GitBarComponent);
    fixture.componentRef.setInput("files", 2);
    fixture.componentRef.setInput("ahead", 3);
    fixture.componentRef.setInput("mergeInto", "leo/flaky-checkout");
    const actions = vi.fn();
    fixture.componentInstance.action.subscribe(actions);
    fixture.detectChanges();
    await fixture.whenStable();
    const button: HTMLButtonElement =
      fixture.nativeElement.querySelector(".primary");
    button.click();
    expect(actions).toHaveBeenLastCalledWith("commit");
    fixture.componentRef.setInput("files", 0);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector(".primary")).toBe(button);
    expect(button.getAttribute("aria-label")).toBe("Merge into flaky-checkout");
    button.click();
    expect(actions).toHaveBeenLastCalledWith("merge");
    fixture.componentRef.setInput("busy", "merge");
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Merging…");
  });

  it("shows supplied job progress, opens its steps and emits session/cancel intents", async () => {
    const fixture = TestBed.createComponent(GitBarComponent);
    const job = {
      id: "merge-1",
      title: "Merge into flaky-checkout",
      steps: [
        { id: "sync", status: "done", label: "Synced with flaky-checkout" },
        {
          id: "resolve",
          status: "running",
          label: "Resolving 3 conflicts",
          short: "resolving 3 conflicts",
          session: { id: "helper", title: "Resolve merge conflicts" },
        },
        { id: "merge", status: "queued", label: "Merge 2 commits" },
      ],
    } as const;
    fixture.componentRef.setInput("job", job);
    fixture.componentRef.setInput("files", 7);
    const sessions = vi.fn();
    const cancelled = vi.fn();
    fixture.componentInstance.jobSessionRequested.subscribe(sessions);
    fixture.componentInstance.jobCancelled.subscribe(cancelled);
    fixture.detectChanges();
    await fixture.whenStable();
    const button: HTMLButtonElement =
      fixture.nativeElement.querySelector(".primary");
    expect(button.getAttribute("aria-label")).toBe(
      "Merging · resolving 3 conflicts",
    );
    expect(button.disabled).toBe(false);
    expect(
      fixture.nativeElement.querySelector(".stat-slot").hasAttribute("inert"),
    ).toBe(true);
    button.focus();
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      document.querySelector("ex-git-job-menu")?.getAttribute("aria-label"),
    ).toBe(job.title);
    const sessionButton = document.querySelector<HTMLButtonElement>(
      "ex-git-job-menu .session",
    );
    sessionButton?.focus();
    fixture.componentRef.setInput("job", { ...job, note: "Progress updated" });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(sessionButton);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    document
      .querySelector<HTMLButtonElement>("ex-git-job-menu .session")
      ?.click();
    expect(sessions).toHaveBeenLastCalledWith("helper");
    document
      .querySelector<HTMLButtonElement>("ex-git-job-menu footer button")
      ?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(cancelled).toHaveBeenLastCalledWith("merge-1");
    fixture.componentRef.setInput("job", { ...job, waiting: true });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(button.getAttribute("aria-label")).toBe("Merge waiting on you");
    button.click();
    expect(sessions).toHaveBeenLastCalledWith("helper");
    fixture.destroy();
    expect(document.querySelector("ex-git-job-menu")).toBeNull();
  });
});
