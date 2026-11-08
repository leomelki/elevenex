import { TestBed } from "@angular/core/testing";
import { CSP_NONCE } from "@angular/core";
import { TerminalStylePolicy } from "./terminal-style-nonce";

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});
function policy() {
  TestBed.configureTestingModule({
    providers: [{ provide: CSP_NONCE, useValue: "app-nonce" }],
  });
  return TestBed.inject(TerminalStylePolicy);
}

describe("Terminal style confinement", () => {
  it("nonces generated sheets and restores the exact factory after all leases close", () => {
    const original = document.createElement,
      descriptor = Object.getOwnPropertyDescriptor(document, "createElement");
    const owner = policy(),
      first = owner.retain(),
      second = owner.retain();
    expect(first.open(() => document.createElement("style")).nonce).toBe(
      "app-nonce",
    );
    expect(document.createElement("style").nonce).toBe("");
    expect(document.createElement("div").getAttribute("nonce")).toBeNull();
    first.release();
    first.release();
    expect(document.createElement).not.toBe(original);
    second.release();
    expect(document.createElement).toBe(original);
    expect(Object.getOwnPropertyDescriptor(document, "createElement")).toEqual(
      descriptor,
    );
  });
  it("uses CSSOM for finite RGB selections and truecolor without assigning a style attribute", () => {
    const native = vi.spyOn(Element.prototype, "setAttribute");
    const release = policy().retain(),
      span = document.createElement("span");
    span.setAttribute(
      "style",
      "background-color:#dcf3f0;color:rgb(14,22,33);text-decoration:underline;",
    );
    expect(span.style.color).toBe("rgb(14, 22, 33)");
    expect(span.style.backgroundColor).toBe("rgb(220, 243, 240)");
    expect(span.style.textDecoration).toBe("underline");
    expect(native).not.toHaveBeenCalled();
    span.setAttribute("style", span.getAttribute("style") + "color:#08716a;");
    expect(span.style.color).toBe("rgb(8, 113, 106)");
    expect(native).not.toHaveBeenCalled();
    release.release();
  });
  it("keeps arbitrary CSS and non-span elements on the browser CSP path", () => {
    const native = vi.spyOn(Element.prototype, "setAttribute");
    const release = policy().retain(),
      span = document.createElement("span");
    for (const style of [
      "background-image:url(https://evil.test)",
      "position:fixed",
      "color:var(--secret)",
      "--custom:red",
    ]) {
      span.setAttribute("style", style);
      expect(native).toHaveBeenLastCalledWith("style", style);
    }
    document.createElement("div").setAttribute("style", "color:#ffffff");
    expect(native).toHaveBeenLastCalledWith("style", "color:#ffffff");
    release.release();
  });
  it("stops adapting existing spans and restores the factory on owner teardown", () => {
    const native = vi.spyOn(Element.prototype, "setAttribute"),
      original = document.createElement;
    const release = policy().retain(),
      span = document.createElement("span");
    TestBed.resetTestingModule();
    release.release();
    expect(document.createElement).toBe(original);
    span.setAttribute("style", "color:#ffffff");
    expect(native).toHaveBeenLastCalledWith("style", "color:#ffffff");
  });
});
