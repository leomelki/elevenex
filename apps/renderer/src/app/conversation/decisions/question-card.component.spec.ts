import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionAnswers } from "../conversation.models";
import { QuestionCardComponent } from "./question-card.component";

describe("QuestionCard answer ownership", () => {
  let fixture: ComponentFixture<QuestionCardComponent>;
  let submissions: QuestionAnswers[];
  beforeEach(async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    await TestBed.configureTestingModule({
      imports: [QuestionCardComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(QuestionCardComponent);
    submissions = [];
    fixture.componentInstance.submitted.subscribe((answers) =>
      submissions.push(answers),
    );
  });
  function pick(label: string): void {
    const labels: HTMLLabelElement[] = Array.from(
      fixture.nativeElement.querySelectorAll("label"),
    );
    const element = labels
      .find((row) => row.textContent?.includes(label))
      ?.querySelector("input");
    if (!(element instanceof HTMLInputElement))
      throw new Error(`Missing ${label}`);
    element.click();
    fixture.detectChanges();
  }
  it("answers a single listed choice immediately without preselection", () => {
    fixture.componentRef.setInput("question", "Which policy?");
    fixture.componentRef.setInput("options", [
      { label: "Backoff", recommended: true },
      { label: "Immediate" },
    ]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("input:checked")).toBeNull();
    pick("Backoff");
    expect(submissions).toEqual([{ question: ["Backoff"] }]);
  });
  it("collects a multi-question run and submits only after all answers are ready", () => {
    fixture.componentRef.setInput("questions", [
      {
        id: "policy",
        question: "Which policy?",
        options: [{ label: "Backoff" }],
      },
      {
        id: "cases",
        question: "Which tests?",
        kind: "multi",
        options: [{ label: "Past date" }, { label: "Cancellation" }],
      },
    ]);
    fixture.detectChanges();
    pick("Backoff");
    expect(submissions).toEqual([]);
    pick("Past date");
    pick("Cancellation");
    const button: Array<HTMLButtonElement> = Array.from(
      fixture.nativeElement.querySelectorAll("button"),
    );
    button.find((item) => item.textContent?.includes("Send answers"))?.click();
    fixture.detectChanges();
    expect(submissions).toEqual([
      { policy: ["Backoff"], cases: ["Past date", "Cancellation"] },
    ]);
  });
  it("keeps a custom answer selected while typing and waits for Send", () => {
    fixture.componentRef.setInput("question", "Which policy?");
    fixture.componentRef.setInput("options", [{ label: "Backoff" }]);
    fixture.detectChanges();
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll("button"),
    );
    buttons
      .find((button) => button.textContent?.includes("Something else"))
      ?.click();
    fixture.detectChanges();
    const field = fixture.nativeElement.querySelector("input[type=text]");
    if (!(field instanceof HTMLInputElement))
      throw new Error("Missing custom answer");
    field.value = "Use the project default";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    fixture.detectChanges();
    expect(submissions).toEqual([]);
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(submissions).toEqual([{ question: ["Use the project default"] }]);
  });
});
