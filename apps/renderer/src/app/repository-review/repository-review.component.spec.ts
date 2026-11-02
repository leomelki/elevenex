import { TestBed } from "@angular/core/testing";
import type {
  BackendResult,
  RepositoryReviewPage,
  RepositoryReviewQuery,
} from "@elevenex/shared";
import { ELEVENEX_BRIDGE } from "../backend/backend-client.service";
import { RepositoryReviewComponent } from "./repository-review.component";

const rev = "a".repeat(64),
  scope = "11111111-1111-1111-1111-111111111111";
const file = {
  id: "staged:new.ts",
  path: "new.ts",
  oldPath: "old.ts",
  status: "R" as const,
  layer: "staged" as const,
  rev,
  add: 1,
  del: 1,
  binary: false,
  large: false,
  countsExact: true,
  oldMode: "100644",
  newMode: "100644",
  oldRevision: "b".repeat(40),
  newRevision: "c".repeat(40),
};
const page: RepositoryReviewPage = {
  taskId: 7,
  source: "uncommitted",
  revision: rev,
  headSha: "d".repeat(40),
  baseSha: "d".repeat(40),
  targetSha: null,
  baseRef: null,
  fingerprint: rev,
  explanation: "Staged and unstaged",
  total: 1,
  matched: 1,
  additions: 1,
  deletions: 1,
  countsExact: true,
  offset: 0,
  nextOffset: null,
  files: [file],
  content: null,
};
describe("repository review presentation and typed owner intents", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });
  async function setup(kind: "add" | "del" = "add") {
    const sent = vi.fn();
    const bridge = {
      sessionChatCommand: sent,
      repositoryReviewCancel: vi.fn(async () => undefined),
      repositoryReview: vi.fn(
        async (
          _scope: string,
          input: RepositoryReviewQuery,
        ): Promise<BackendResult<RepositoryReviewPage>> => ({
          ok: true,
          value: {
            ...page,
            content: input.fileId
              ? {
                  fileId: file.id,
                  rev,
                  mode: input.mode ?? "changes",
                  offset: 0,
                  nextOffset: null,
                  hunks: [
                    {
                      id: "h",
                      heading: "@@",
                      lines: [
                        {
                          id: "line",
                          kind,
                          text: "const exact = true;",
                          ...(kind === "del"
                            ? { oldNumber: 12 }
                            : { newNumber: 12 }),
                        },
                      ],
                    },
                  ],
                }
              : null,
          },
        }),
      ),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: ELEVENEX_BRIDGE, useValue: bridge }],
    });
    const fixture = TestBed.createComponent(RepositoryReviewComponent);
    fixture.componentRef.setInput("target", { scopeId: scope, taskId: 7 });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.componentInstance.store.request({
      fileId: file.id,
      rev,
      mode: "changes",
      reason: "selected",
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return {
      fixture,
      component: fixture.componentInstance,
      root: fixture.nativeElement as HTMLElement,
      sent,
    };
  }
  for (const kind of ["add", "del"] as const)
    it(`hands a ${kind} line question to the owner with exact side/revisions and never sends it`, async () => {
      const { fixture, component, root, sent } = await setup(kind);
      const questions = vi.fn();
      component.questionRequested.subscribe(questions);
      root
        .querySelector<HTMLButtonElement>('[aria-label="Ask about line 12"]')!
        .click();
      fixture.detectChanges();
      const input = root.querySelector<HTMLTextAreaElement>("textarea")!;
      input.value = "Why this change?";
      input.dispatchEvent(new Event("input"));
      fixture.detectChanges();
      root
        .querySelector<HTMLFormElement>("form")!
        .dispatchEvent(new Event("submit", { cancelable: true }));
      fixture.detectChanges();
      expect(questions).toHaveBeenCalledWith({
        text: "Why this change?",
        location: expect.objectContaining({
          scopeId: scope,
          taskId: 7,
          revision: rev,
          fileRev: rev,
          fileId: file.id,
          source: "uncommitted",
          line: 12,
          side: kind === "del" ? "old" : "new",
          path: kind === "del" ? "old.ts" : "new.ts",
          contentRevision: kind === "del" ? file.oldRevision : file.newRevision,
        }),
      });
      expect(sent).not.toHaveBeenCalled();
    });
  it("keeps unavailable Code capability hidden and emits a precise intent when the owner enables it", async () => {
    const { fixture, component, root, sent } = await setup();
    expect(root.querySelector('[aria-label="Open new.ts in Code"]')).toBeNull();
    fixture.componentRef.setInput("codeAvailable", true);
    fixture.detectChanges();
    const opened = vi.fn();
    component.codeRequested.subscribe(opened);
    root
      .querySelector<HTMLButtonElement>('[aria-label="Open new.ts in Code"]')!
      .click();
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 7,
        scopeId: scope,
        fileRev: rev,
        revision: rev,
        line: 1,
        side: "new",
        contentRevision: file.newRevision,
      }),
    );
    expect(sent).not.toHaveBeenCalled();
  });
  it('keeps search and Viewed totals in the file picker, and closes the portaled picker when inactive', async () => {
    const { fixture, root } = await setup();
    expect(root.querySelector('[aria-label="Search all changed files"]')).toBeNull();
    expect(root.querySelector('.comparison')).toBeNull();
    expect(root.querySelector('details')).toBeNull();
    root.querySelector<HTMLButtonElement>('ex-diff-review .jump')!.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(document.querySelector('.file-menu [aria-label="Search all changed files"]')).not.toBeNull();
    expect(document.querySelector('.picker-viewed')?.textContent).toContain('0/1 viewed');
    fixture.componentRef.setInput('active', false); fixture.detectChanges(); await fixture.whenStable();
    expect(document.querySelector('.file-menu')).toBeNull();
    fixture.componentRef.setInput('active', true); fixture.detectChanges(); await fixture.whenStable();
    root.querySelector<HTMLButtonElement>('[aria-label="Review mode"] button:nth-child(2)')!.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(fixture.componentInstance.store.mode()).toBe('full');

  });

});
