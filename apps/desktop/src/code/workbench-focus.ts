/** Runs in the Code document before upstream starts. Workbench startup and view
 * commands focus DOM elements even during passive layout. An embedded document
 * may keep its existing focus, but the parent or native input must grant it.
 * Monaco can focus its input directly from a trusted click, before the browser
 * processes the gesture's default focus action. */
export function keepWorkbenchFocusLocal(): void {
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions): void {
    const input = window.event;
    if (this.ownerDocument === document && !document.hasFocus() &&
        !(input?.isTrusted && /^(?:pointerdown|mousedown|click|keydown)$/.test(input.type))) return;
    focus.call(this, options);
  };
}
