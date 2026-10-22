import { TestBed } from "@angular/core/testing";
import { SegmentedComponent } from "./segmented.component";
import { SwitchComponent } from "./switch.component";
import { FoldComponent } from "../motion/fold.component";
import { PresenceComponent } from "../motion/presence.component";

describe("Accessible local controls", () => {
  it("moves radio focus with arrows, skips disabled options and emits the chosen id", () => {
    const fixture = TestBed.createComponent(SegmentedComponent);
    fixture.componentRef.setInput("label", "Thinking level");
    fixture.componentRef.setInput("value", "low");
    fixture.componentRef.setInput("options", [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium", disabled: true },
      { id: "high", label: "High" },
    ]);
    fixture.detectChanges();
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    const buttons = fixture.nativeElement.querySelectorAll(
      "button",
    ) as NodeListOf<HTMLButtonElement>;
    buttons[0]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(changed).toHaveBeenCalledWith("high");
    expect(document.activeElement).toBe(buttons[2]);
    fixture.componentRef.setInput("value", "high");
    fixture.detectChanges();
    expect(buttons[2]!.getAttribute("aria-checked")).toBe("true");
    expect(buttons[2]!.tabIndex).toBe(0);
    expect(buttons[0]!.tabIndex).toBe(-1);
  });

  it("keeps a controlled switch unchanged until its owner applies the emitted intent", () => {
    const fixture = TestBed.createComponent(SwitchComponent);
    fixture.componentRef.setInput("label", "Fast mode");
    fixture.detectChanges();
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    const button = fixture.nativeElement.querySelector(
      "button",
    ) as HTMLButtonElement;
    button.click();
    expect(changed).toHaveBeenCalledWith(true);
    expect(button.getAttribute("aria-checked")).toBe("false");
    fixture.componentRef.setInput("on", true);
    fixture.detectChanges();
    expect(button.getAttribute("aria-checked")).toBe("true");
  });

  it.each(["missing", "disabled"])(
    "keeps an enabled segment reachable when the selected option is %s",
    (value) => {
      const fixture = TestBed.createComponent(SegmentedComponent);
      fixture.componentRef.setInput("label", "Thinking level");
      fixture.componentRef.setInput("value", value);
      fixture.componentRef.setInput("options", [
        { id: "disabled", label: "Unavailable", disabled: true },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ]);
      fixture.detectChanges();
      const buttons: NodeListOf<HTMLButtonElement> =
        fixture.nativeElement.querySelectorAll("button");
      expect(Array.from(buttons, (button) => button.tabIndex)).toEqual([
        -1, 0, -1,
      ]);
      const changed = vi.fn();
      fixture.componentInstance.changed.subscribe(changed);
      buttons[1]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
      expect(changed).toHaveBeenCalledWith("high");
      expect(document.activeElement).toBe(buttons[2]);
    },
  );

  it("makes leaving presence content inert until it is shown again", () => {
    const fixture = TestBed.createComponent(PresenceComponent);
    fixture.componentRef.setInput("show", true);
    fixture.detectChanges();
    expect(fixture.nativeElement.hasAttribute("inert")).toBe(false);
    fixture.componentRef.setInput("show", false);
    fixture.detectChanges();
    expect(fixture.nativeElement.hasAttribute("inert")).toBe(true);
    expect(fixture.nativeElement.getAttribute("aria-hidden")).toBe("true");
    fixture.componentRef.setInput("show", true);
    fixture.detectChanges();
    expect(fixture.nativeElement.hasAttribute("inert")).toBe(false);
  });

  it("makes a mounted closed fold inert and hidden from assistive technology", () => {
    const fixture = TestBed.createComponent(FoldComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.hasAttribute("inert")).toBe(true);
    expect(fixture.nativeElement.getAttribute("aria-hidden")).toBe("true");
    fixture.componentRef.setInput("open", true);
    fixture.detectChanges();
    expect(fixture.nativeElement.hasAttribute("inert")).toBe(false);
    expect(fixture.nativeElement.getAttribute("aria-hidden")).toBe("false");
  });
});
