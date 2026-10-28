import { ComponentFixture, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatedTask, PlannedTask } from "../task.models";
import { NewTaskComponent } from "./new-task.component";

describe("NewTask keyboard flow", () => {
  let fixture: ComponentFixture<NewTaskComponent>;
  beforeEach(async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await TestBed.configureTestingModule({
      imports: [NewTaskComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(NewTaskComponent);
    fixture.componentRef.setInput("project", {
      name: "Elevenex",
      hue: "ocean",
    });
    fixture.componentRef.setInput("branches", [
      { name: "main", isDefault: true },
      { name: "feature/existing" },
      { name: "feature/held", task: "Other task" },
    ]);
    fixture.componentRef.setInput("autoFocus", false);
  });
  function field(label: string): HTMLInputElement {
    const element = fixture.nativeElement.querySelector(
      `input[aria-label="${label}"]`,
    );
    if (!(element instanceof HTMLInputElement))
      throw new Error(`Missing ${label} input`);
    return element;
  }
  function key(
    element: HTMLElement,
    keyValue: string,
    options: KeyboardEventInit = {},
  ): void {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: keyValue,
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    );
    fixture.detectChanges();
  }
  function name(value: string): void {
    const input = field("Task name");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    fixture.detectChanges();
  }

  it("creates a new branch from the project default with three Enter presses", () => {
    const created: CreatedTask[] = [];
    fixture.componentInstance.create.subscribe((value) => created.push(value));
    fixture.detectChanges();
    name("Rate-limit refunds");
    key(field("Task name"), "Enter");
    key(field("Branch: type to search or create"), "Enter");
    key(field("Start from"), "Enter");
    expect(created).toEqual([
      {
        title: "Rate-limit refunds",
        branch: "rate-limit-refunds",
        existing: false,
        base: "main",
        workspace: "auto",
      },
    ]);
  });

  it('does not repeat a branch request when repository/default metadata is rebound with the same identity', () => {
    const requested: { readonly repoId: string; readonly query: string; readonly kind: 'branch' | 'base' }[] = [];
    fixture.componentRef.setInput('repos', [{ id: 'repo', name: 'Repository', base: 'main' }]);
    fixture.componentInstance.branchQueryRequested.subscribe(request => requested.push(request));
    fixture.detectChanges(); name('New feature');
    key(field('Task name'), 'Enter');
    expect(requested).toEqual([{ repoId: 'repo', query: 'new-feature', kind: 'branch' }]);
    fixture.componentRef.setInput('repos', [{ id: 'repo', name: 'Repository', base: 'main' }]);
    fixture.componentRef.setInput('branches', [{ name: 'main', isDefault: true }, { name: 'feature/existing' }]);
    fixture.componentRef.setInput('branchesLoading', false);
    fixture.detectChanges();
    expect(requested).toHaveLength(1);
    key(field('Branch: type to search or create'), 'Enter');
    expect(requested.at(-1)).toEqual({ repoId: 'repo', query: '', kind: 'base' });
    fixture.componentRef.setInput('repos', [{ id: 'repo', name: 'Repository', base: 'main' }]);
    fixture.detectChanges();
    expect(requested).toHaveLength(2);
  });
  it("advances an existing branch to From, focuses Create, then keeps its own history", async () => {
    const created: CreatedTask[] = [];
    fixture.componentInstance.create.subscribe((value) => created.push(value));
    fixture.componentRef.setInput("title", "Existing task");
    fixture.componentRef.setInput("branchQuery", "feature/existing");
    fixture.detectChanges();
    key(field("Task name"), "Enter");
    key(field("Branch: type to search or create"), "Enter");
    await fixture.whenStable();
    expect(document.activeElement).toBe(
      fixture.nativeElement.querySelector("footer .next"),
    );
    expect(created).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain(
      "already exists and keeps its history",
    );
    fixture.nativeElement.querySelector("footer .next").click();
    expect(created[0]).toMatchObject({
      branch: "feature/existing",
      existing: true,
      base: null,
    });
  });
  it("keeps Create enabled and focused for an existing branch without requesting unused bases", async () => {
    const requested: { readonly kind: "branch" | "base" }[] = [];
    fixture.componentRef.setInput("repos", [{ id: "repo", name: "Repository", base: "main" }]);
    fixture.componentRef.setInput("title", "Existing task");
    fixture.componentRef.setInput("branchQuery", "feature/existing");
    // Mirror the connected owner's loading state when a picker requests data.
    fixture.componentInstance.branchQueryRequested.subscribe(request => {
      requested.push(request);
      if (request.kind === "base") fixture.componentRef.setInput("branchesLoading", true);
    });
    fixture.detectChanges();
    key(field("Task name"), "Enter");
    await fixture.whenStable();
    key(field("Branch: type to search or create"), "Enter");
    await fixture.whenStable();
    const create = fixture.nativeElement.querySelector("footer .next");
    expect(requested.map(request => request.kind)).toEqual(["branch"]);
    expect(create.disabled).toBe(false);
    expect(document.activeElement).toBe(create);
  });

  it("uses the selected repository branches and default through four Enter presses", () => {
    const created: CreatedTask[] = [];
    fixture.componentInstance.create.subscribe((value) => created.push(value));
    fixture.componentRef.setInput("repos", [
      { id: "api", name: "API", path: "~/api", base: "main" },
      { id: "web", name: "Web", path: "~/web", base: "develop" },
    ]);
    fixture.componentRef.setInput("repo", "web");
    fixture.componentRef.setInput("branchesFor", (repo: string) =>
      repo === "web"
        ? [{ name: "develop" }, { name: "web-only" }]
        : [{ name: "main" }],
    );
    fixture.detectChanges();
    name("Repository task");
    key(field("Task name"), "Enter");
    const repositories = fixture.nativeElement.querySelector(
      '[role="listbox"][aria-label="Repository"]',
    );
    expect(
      repositories.querySelector('[aria-selected="true"]').textContent,
    ).toContain("Web");
    key(repositories, "Enter");
    key(field("Branch: type to search or create"), "Enter");
    expect(field("Start from").closest(".body")?.textContent).toContain(
      "develop",
    );
    key(field("Start from"), "Enter");
    expect(created).toEqual([
      {
        title: "Repository task",
        repo: "web",
        branch: "repository-task",
        existing: false,
        base: "develop",
        workspace: "auto",
      },
    ]);
  });
  it("the main action follows the current step and rejects stale supplied branch data", () => {
    const create = vi.fn();
    fixture.componentInstance.create.subscribe(create);
    fixture.detectChanges();
    const next = fixture.nativeElement.querySelector(
      "footer .next",
    ) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    name("Existing");
    next.click();
    fixture.detectChanges();
    const branch = field("Branch: type to search or create");
    branch.value = "feature/existing";
    branch.dispatchEvent(new Event("input", { bubbles: true }));
    fixture.detectChanges();
    next.click();
    fixture.detectChanges();
    expect(next.textContent).toContain("Create task");
    fixture.componentRef.setInput("branches", [
      { name: "main" },
      { name: "feature/existing", task: "Now held" },
    ]);
    fixture.detectChanges();
    expect(next.disabled).toBe(true);
    next.click();
    expect(create).not.toHaveBeenCalled();
  });
  it("does not create a held or invalid branch", () => {
    const create = vi.fn();
    fixture.componentInstance.create.subscribe(create);
    fixture.componentRef.setInput("title", "Held task");
    fixture.componentRef.setInput("branchQuery", "feature/held");
    fixture.detectChanges();
    key(field("Task name"), "Enter");
    key(field("Branch: type to search or create"), "Enter");
    key(field("Branch: type to search or create"), "Enter", { metaKey: true });
    expect(create).not.toHaveBeenCalled();
    const input = field("Branch: type to search or create");
    input.value = "invalid..branch";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    fixture.detectChanges();
    key(input, "Enter");
    expect(create).not.toHaveBeenCalled();
  });
  it("highlights the live starting-branch search without inserting spaces into the name", () => {
    fixture.componentRef.setInput("branches", [{ name: "main" }, { name: "develop" }]);
    fixture.componentRef.setInput("step", "base");
    fixture.componentRef.setInput("title", "New feature");
    fixture.detectChanges();
    const input = field("Start from");
    input.value = "de";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    fixture.detectChanges();
    const label = input.closest(".body")?.querySelector('[role="option"] .mono');
    expect(label?.textContent).toBe("develop");
    expect(label?.querySelector("mark")?.textContent).toBe("de");
  });
  it("saves Planned with Alt Enter, creates immediately with Cmd Enter, and cancels with Escape", () => {
    const plans: PlannedTask[] = [];
    const created: CreatedTask[] = [];
    const cancel = vi.fn();
    fixture.componentInstance.plan.subscribe((value) => plans.push(value));
    fixture.componentInstance.create.subscribe((value) => created.push(value));
    fixture.componentInstance.cancelled.subscribe(cancel);
    fixture.detectChanges();
    name("Fix retries");
    key(field("Task name"), "Enter", { altKey: true });
    expect(plans[0]).toMatchObject({
      title: "Fix retries",
      branch: "fix-retries",
    });
    key(field("Task name"), "Enter", { metaKey: true });
    expect(created[0]?.base).toBe("main");
    key(field("Task name"), "Escape");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("goes back without discarding the draft", () => {
    fixture.detectChanges();
    name("Preserve me");
    key(field("Task name"), "Enter");
    key(field("Branch: type to search or create"), "Tab", { shiftKey: true });
    expect(field("Task name").value).toBe("Preserve me");
    expect(
      field("Task name").closest("ex-fold")?.getAttribute("aria-hidden"),
    ).toBe("false");
  });
  it("moves focus to the next field and selects the inferred answer immediately", async () => {
    fixture.componentRef.setInput("autoFocus", true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(field("Task name"));
    name("Focus the branch");
    key(field("Task name"), "Enter");
    await fixture.whenStable();
    const branch = field("Branch: type to search or create");
    expect(document.activeElement).toBe(branch);
    expect(branch.selectionStart).toBe(0);
    expect(branch.selectionEnd).toBe(branch.value.length);
  });
});
