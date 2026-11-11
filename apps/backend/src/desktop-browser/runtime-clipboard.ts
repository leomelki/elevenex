import type { Frame, Page } from 'playwright-core';

/** Page-owned, read-only selection access. A timeout cannot cancel Chromium's
 * evaluator, so retain single-flight ownership until it actually settles.
 */
export class RuntimeBrowserClipboard {
  private reading?: Promise<string>;
  private cancel?: () => void;
  private disposed = false;

  constructor(
    private readonly page: Page,
    private readonly deadlineMs = 1000,
  ) {}

  async read(current: () => void): Promise<string> {
    if (this.disposed || this.reading || this.cancel)
      throw new Error('Browser clipboard is unavailable');
    let expired = false;
    const check = () => {
      current();
      if (expired || this.disposed)
        throw new Error('Browser clipboard interrupted');
    };
    check();
    const operation = this.selection(check);
    this.reading = operation;
    void operation
      .finally(() => {
        if (this.reading === operation) this.reading = undefined;
      })
      .catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      this.cancel = () => {
        expired = true;
        reject(new Error('Browser clipboard interrupted'));
      };
      timer = setTimeout(this.cancel, this.deadlineMs);
    });
    try {
      const text = await Promise.race([operation, interrupted]);
      check();
      return text;
    } finally {
      clearTimeout(timer);
      this.cancel = undefined;
    }
  }

  destroy(): void {
    this.disposed = true;
    this.cancel?.();
  }

  private async selection(current: () => void): Promise<string> {
    let frame = this.page.mainFrame();
    // Follow actual focus across cross-origin frames without exposing an
    // evaluator, handles, field contents or host clipboard access to callers.
    for (let depth = 0; depth < 20; depth++) {
      current();
      const element = await frame.evaluateHandle(() => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement)
          active = active.shadowRoot.activeElement;
        return active;
      });
      let next: Frame | null | undefined;
      try {
        current();
        next = await element.asElement()?.contentFrame();
        current();
      } finally {
        await element.dispose();
      }
      if (next) {
        frame = next;
        continue;
      }
      current();
      const text = await frame.evaluate(() => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement)
          active = active.shadowRoot.activeElement;
        if (active instanceof HTMLInputElement && active.type === 'password')
          return '';
        if (
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement
        )
          return active.value
            .slice(active.selectionStart ?? 0, active.selectionEnd ?? 0)
            .slice(0, 65536);
        return (getSelection()?.toString() ?? '').slice(0, 65536);
      });
      current();
      return text;
    }
    throw new Error('Focused browser frame limit reached');
  }
}
