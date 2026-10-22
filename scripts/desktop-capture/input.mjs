/** Trusted browser input. The owning capture supplies page evaluation and CDP. */
export class CaptureInput {
  constructor(page) { this.page = page; }

  async rect(selector) {
    return this.page.evaluate(selector => {
      const elements = document.querySelectorAll(selector);
      if (elements.length !== 1) throw new Error(`Expected one element at ${selector}, got ${elements.length}`);
      const element = elements[0];
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') throw new Error(`Element is hidden: ${selector}`);
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, disabled: element.matches(':disabled') };
    }, selector);
  }

  async hover(selector) {
    const rect = await this.rect(selector);
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await this.page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.page.settle();
  }

  async click(selector) {
    const rect = await this.rect(selector);
    if (rect.disabled) throw new Error(`Cannot click disabled control: ${selector}`);
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = await this.page.evaluate((selector, x, y) => document.querySelector(selector).contains(document.elementFromPoint(x, y)), selector, x, y);
    if (!hit) throw new Error(`Click target is covered or outside the viewport: ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) await this.page.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await this.page.settle();
  }

  async press(key, modifiers = 0) {
    // For complex keyboard/touch/drag input use cdp directly with explicit fields.
    for (const type of ['keyDown', 'keyUp']) await this.page.cdp('Input.dispatchKeyEvent', { type, key, modifiers,
      ...(key.length === 1 ? { text: type === 'keyDown' ? key : '' } : {}),
      ...({ Tab: { windowsVirtualKeyCode: 9 }, Enter: { windowsVirtualKeyCode: 13 }, Escape: { windowsVirtualKeyCode: 27 } }[key] ?? {}),
    });
    await this.page.settle();
  }

  async fill(selector, value) {
    await this.click(selector);
    await this.page.evaluate(selector => {
      const input = document.querySelector(selector);
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || input.readOnly) throw new Error('fill needs an editable input or textarea');
      input.select();
    }, selector);
    await this.page.cdp('Input.insertText', { text: String(value) });
    await this.page.settle();
  }
}
