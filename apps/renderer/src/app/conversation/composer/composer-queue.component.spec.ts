import { TestBed } from "@angular/core/testing";
import { ComposerQueueComponent } from "./composer-queue.component";

describe("Composer queue receipt identity", () => {
  it("retains the optimistic row and sends actions with its saved ID", async () => {
    const fixture = TestBed.createComponent(ComposerQueueComponent);
    fixture.componentRef.setInput("items", [{ id: "local", text: "Follow up" }]);
    fixture.detectChanges();
    await fixture.whenStable();
    const row = fixture.nativeElement.querySelector(".item");
    const removed: string[] = [];
    fixture.componentInstance.remove.subscribe(id => removed.push(id));

    fixture.componentRef.setInput("items", [{ id: "saved", renderId: "local", text: "Follow up" }]);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelectorAll(".item")).toHaveLength(1);
    expect(fixture.nativeElement.querySelector(".item")).toBe(row);
    row.querySelector('[aria-label="Remove queued message"]').click();
    expect(removed).toEqual(["saved"]);
    fixture.destroy();
  });
});
