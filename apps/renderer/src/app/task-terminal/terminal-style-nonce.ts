import { CSP_NONCE, DestroyRef, Injectable, inject } from "@angular/core";
import { DOCUMENT } from "@angular/common";

export interface TerminalStyleLease {
  open<T>(operation: () => T): T;
  release(): void;
}

/**
 * Window-owned compatibility for xterm 6.0's DOM renderer: viewport styles bypass
 * documentOverride, and RGB/selection spans use setAttribute('style'). Keep CSP
 * strict: nonce generated sheets and translate only its finite color/underline
 * declarations to CSSOM. Raw HTML and arbitrary CSS never enter this adapter.
 * The document factory is restored when the last terminal releases its lease.
 */
@Injectable({ providedIn: "root" })
export class TerminalStylePolicy {
  private readonly document = inject(DOCUMENT);
  private readonly nonce = inject(CSP_NONCE, { optional: true });
  private count = 0;
  private opening = 0;
  private disposed = false;
  private restore?: () => void;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      this.count = 0;
      this.restore?.();
      this.restore = undefined;
    });
  }

  retain(): TerminalStyleLease {
    if (this.disposed) throw new Error("Terminal style owner is closed");
    if (!this.count) this.install();
    this.count++;
    let released = false;
    return {
      open: <T>(operation: () => T): T => {
        if (released || this.disposed)
          throw new Error("Terminal style lease is closed");
        this.opening++;
        try {
          return operation();
        } finally {
          this.opening--;
        }
      },
      release: () => {
        if (released || this.disposed) return;
        released = true;
        if (--this.count === 0) {
          this.restore?.();
          this.restore = undefined;
        }
      },
    };
  }

  private install(): void {
    const document = this.document;
    const descriptor = Object.getOwnPropertyDescriptor(
      document,
      "createElement",
    );
    const factory = new Proxy(document.createElement, {
      apply: (target, _receiver, args: unknown[]) => {
        const element: unknown = Reflect.apply(target, document, args);
        if (
          element instanceof HTMLStyleElement &&
          this.nonce &&
          this.opening > 0
        )
          element.nonce = this.nonce;
        if (element instanceof HTMLSpanElement) {
          element.setAttribute = new Proxy(element.setAttribute, {
            apply: (setter, _element, attributes: unknown[]) => {
              if (
                this.count > 0 &&
                !this.disposed &&
                attributes[0] === "style" &&
                typeof attributes[1] === "string" &&
                applyTerminalColors(element, attributes[1])
              )
                return;
              return Reflect.apply(setter, element, attributes);
            },
          });
        }
        return element;
      },
    });
    document.createElement = factory;
    this.restore = () => {
      if (descriptor)
        Object.defineProperty(document, "createElement", descriptor);
      else Reflect.deleteProperty(document, "createElement");
    };
  }
}

/** Fixed renderer values only; URL, var(), custom properties and layout are rejected. */
function applyTerminalColors(
  element: HTMLSpanElement,
  source: string,
): boolean {
  if (source.length > 1024) return false;
  const declarations = source
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const parsed: { property: string; value: string }[] = [];
  for (const declaration of declarations) {
    const match =
      /^(color|background-color|text-decoration-color)\s*:\s*(#[a-f\d]{3,8}|rgba?\([\d\s.,%/+-]+\))$/i.exec(
        declaration,
      );
    if (match)
      parsed.push({ property: match[1]!.toLowerCase(), value: match[2]! });
    else if (/^text-decoration\s*:\s*underline$/i.test(declaration))
      parsed.push({ property: "text-decoration", value: "underline" });
    else return false;
  }
  // CSSOM property writes are allowed by CSP; never assign cssText/style attributes.
  while (element.style.length)
    element.style.removeProperty(element.style.item(0));
  for (const { property, value } of parsed)
    element.style.setProperty(property, value);
  return true;
}
