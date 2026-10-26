import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCardComponent } from "./approval-card.component";

describe("ApprovalCard keyboard decisions", () => {
  it("preserves the focused decision instead of approving on bubbled Enter", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    await TestBed.configureTestingModule({
      imports: [ApprovalCardComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ApprovalCardComponent);
    const decisions: string[] = [];
    fixture.componentInstance.resolve.subscribe((value) =>
      decisions.push(value),
    );
    fixture.detectChanges();
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll("button"),
    );
    const deny = buttons.find((button) => button.textContent?.includes("Deny"));
    if (!deny) throw new Error("Missing Deny button");
    deny.focus();
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    deny.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(decisions).toEqual([]);
    // jsdom does not synthesize the native click after keyboard activation.
    deny.click();
    expect(decisions).toEqual(["denied"]);
    fixture.nativeElement.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(decisions).toEqual(["denied", "always"]);
  });
});
