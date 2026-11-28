import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskGroupComponent } from "./task-group.component";
import { TaskListComponent } from "./task-list.component";
import { TaskHeaderComponent } from "../lifecycle/task-header.component";
import type { SubTask, TaskOutline } from "../task.models";

const subtasks: readonly SubTask[] = [
  {
    id: "parent",
    title: "Null total on empty cart",
    sessions: [
      { id: "parent-session", title: "Guard empty cart", status: "running" },
    ],
  },
  {
    id: "child",
    title: "Rounding in totals",
    parent: "parent",
    sessions: [
      { id: "child-session", title: "Use integer cents", status: "attention" },
    ],
  },
  {
    id: "deep",
    title: "Currency edge cases",
    parent: "child",
    sessions: [
      {
        id: "deep-session",
        title: "EUR cases",
        status: "running",
        kind: "auto",
      },
    ],
  },
  { id: "fourth", title: "Fourth", sessions: [] },
  {
    id: "fifth",
    title: "Fifth",
    sessions: [
      { id: "selected", title: "Selected overflow", status: "review" },
    ],
  },
];
const task: TaskOutline = {
  id: "task",
  title: "Fix checkout",
  sessions: [{ id: "done", title: "Finished", status: "done" }],
  subtasks,
};

describe("sub-task public behavior", () => {
  beforeEach(() =>
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    })),
  );
  afterEach(() => vi.unstubAllGlobals());
  it("lights only the ancestry marks and keeps the selected overflow visible", () => {
    const fixture = TestBed.createComponent(TaskGroupComponent);
    fixture.componentRef.setInput("task", task);
    fixture.componentRef.setInput("selected", "deep-session");
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll("ex-subtask-row.lit")).toHaveLength(3);
    expect(
      root
        .querySelector('[data-subtask-id="deep"] .toggle')
        ?.getAttribute("aria-label"),
    ).toBe(
      "Currency edge cases, in Fix checkout, in Null total on empty cart, in Rounding in totals",
    );
    expect(
      root.querySelector('[data-subtask-id="deep"] [aria-current="true"]')
        ?.textContent,
    ).toContain("EUR cases");
    expect(root.textContent).toContain("2 more sub-tasks");
    fixture.componentRef.setInput("selected", "selected");
    fixture.detectChanges();
    expect(
      root.querySelector('[data-subtask-id="fifth"] [aria-current="true"]')
        ?.textContent,
    ).toContain("Selected overflow");
    expect(root.textContent).toContain("1 more sub-tasks");
    expect(root.querySelector("header .ask")?.textContent).toContain("1");
  });
  it("opens the overflow, emits the sub-task ID and folds only merged branches", () => {
    const fixture = TestBed.createComponent(TaskGroupComponent);
    fixture.componentRef.setInput("task", task);
    fixture.detectChanges();
    const add = vi.fn();
    fixture.componentInstance.addSubtaskSession.subscribe(add);
    const root = fixture.nativeElement as HTMLElement;
    Array.from(root.querySelectorAll<HTMLButtonElement>(".outline-action"))
      .find((button) => button.textContent?.includes("more sub-tasks"))
      ?.click();
    fixture.detectChanges();
    expect(root.querySelectorAll("ex-subtask-row")).toHaveLength(5);
    root
      .querySelector<HTMLButtonElement>(
        '[data-subtask-id="child"] ex-icon-button button',
      )
      ?.click();
    expect(add).toHaveBeenCalledWith("child");
    fixture.componentRef.setInput("task", {
      ...task,
      subtasks: [{ ...subtasks[0], merged: true, diff: { add: 12, del: 3 } }],
    });
    fixture.detectChanges();
    expect(root.querySelectorAll("ex-subtask-row")).toHaveLength(0);
    expect(root.textContent).not.toContain("1 finished");
    expect(root.textContent).toContain("1 merged");
    root
      .querySelector<HTMLButtonElement>(".merged-summary .outline-action")
      ?.click();
    fixture.detectChanges();
    expect(root.querySelector(".merged")?.closest("[inert]")).toBeNull();
    expect(root.querySelector(".merged")?.textContent).toContain("+12");
  });
  it("keeps completed sub-task sessions visible in their original order", () => {
    const fixture = TestBed.createComponent(TaskGroupComponent);
    const sessions = [
      { id: 'first', title: 'First conversation', status: 'running' as const },
      { id: 'second', title: 'Second conversation', status: 'running' as const },
    ];
    const parent: TaskOutline = { id: 'task', title: 'Work', sessions: [], subtasks: [{ id: 'child', title: 'Child', sessions }] };
    fixture.componentRef.setInput('task', parent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const rows = [...root.querySelectorAll('ex-session-row')];
    fixture.componentRef.setInput('task', { ...parent, subtasks: [{ id: 'child', title: 'Child', sessions: [{ ...sessions[0], status: 'done' }, sessions[1]] }] });
    fixture.detectChanges();
    expect([...root.querySelectorAll('ex-session-row')]).toEqual(rows);
    expect(rows[0]?.textContent).toContain('First conversation');
    expect(rows[0]?.closest('[inert]')).toBeNull();
    expect(rows[1]?.closest('[inert]')).toBeNull();
    expect(root.textContent).not.toContain('1 finished');
    fixture.componentRef.setInput('filter', 'done');
    fixture.detectChanges();
    expect(root.querySelector('ex-session-row')?.textContent).toContain('First conversation');
  });

  it("filters using sub-task sessions and preserves the selected session intent", () => {
    const fixture = TestBed.createComponent(TaskListComponent);
    fixture.componentRef.setInput("tasks", [task]);
    fixture.componentRef.setInput("filter", "attention");
    const select = vi.fn();
    fixture.componentInstance.selectSession.subscribe(select);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const row = root.querySelector<HTMLButtonElement>("ex-session-row button");
    expect(row?.textContent).toContain("Use integer cents");
    row?.click();
    expect(select).toHaveBeenCalledWith({
      taskId: "task",
      sessionId: "child-session",
    });
    expect(
      root.querySelector('[data-task-id="task"]')?.closest("[inert]"),
    ).toBeNull();
  });
  it("exposes repository details and opens the supplied parent without platform access", () => {
    const fixture = TestBed.createComponent(TaskHeaderComponent);
    fixture.componentRef.setInput("title", "Rounding");
    fixture.componentRef.setInput("repo", {
      name: "Storefront",
      short: "web",
      path: "~/code/web",
    });
    const parent = {
      id: "parent",
      title: "Fix checkout",
      branch: "fix/checkout",
    };
    fixture.componentRef.setInput("parent", parent);
    const opened = vi.fn();
    fixture.componentInstance.parentRequested.subscribe(opened);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector("ex-repo-tag")?.getAttribute("title")).toBe(
      "Storefront · ~/code/web",
    );
    root.querySelector<HTMLButtonElement>(".parent")?.click();
    expect(opened).toHaveBeenCalledWith(parent);
  });
});
