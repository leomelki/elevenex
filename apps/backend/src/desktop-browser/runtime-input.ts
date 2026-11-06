import type { CDPSession, Page } from 'playwright-core';
import type { TaskBrowserStreamEvent } from '@elevenex/shared';

/** Page-owned human input. Cleanup is ordered after accepted writes and before new input. */
export class RuntimeBrowserInput {
  private readonly keys = new Map<
    string,
    Extract<TaskBrowserStreamEvent, { kind: 'key' }>
  >();
  private readonly buttons = new Map<
    string,
    Extract<TaskBrowserStreamEvent, { kind: 'pointer' }>
  >();
  private composing = false;
  private revision = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  settled(): Promise<unknown> {
    return this.tail;
  }

  dispatch(
    input: TaskBrowserStreamEvent,
    current: () => void,
  ): Promise<{ clipboard?: string }> {
    if (input.kind === 'release') return this.reset().then(() => ({}));
    const revision = this.revision;
    const check = () => {
      current();
      if (revision !== this.revision)
        throw new Error('Browser input was interrupted');
    };
    const result = this.tail.then(async () => {
      check();
      return this.deliver(input, check);
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  reset(): Promise<void> {
    this.revision++;
    const result = this.tail.then(async () => {
      const keys = [...this.keys.values()],
        buttons = [...this.buttons.values()],
        composing = this.composing;
      this.keys.clear();
      this.buttons.clear();
      this.composing = false;
      if (this.page.isClosed()) return;
      // Cancel drag before releases so losing the presentation cannot drop an item.
      if (buttons.length)
        await this.cdp.send('Input.cancelDragging').catch(() => undefined);
      for (const button of buttons)
        await this.cdp
          .send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: button.x,
            y: button.y,
            button: button.button,
            buttons: 0,
            clickCount: 0,
            modifiers: 0,
          })
          .catch(() => undefined);
      for (const key of keys)
        await this.cdp
          .send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: key.key,
            code: key.code,
            windowsVirtualKeyCode: key.keyCode,
            modifiers: 0,
          })
          .catch(() => undefined);
      if (composing)
        await this.cdp
          .send('Input.imeSetComposition', {
            text: '',
            selectionStart: 0,
            selectionEnd: 0,
          })
          .catch(() => undefined);
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async edit(command: 'Undo' | 'Redo' | 'SelectAll'): Promise<void> {
    // Blink commands follow the viewing device's intent, regardless of the host OS.
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      commands: [command],
    });
  }

  private async deliver(
    input: Exclude<TaskBrowserStreamEvent, { kind: 'release' }>,
    current: () => void,
  ): Promise<{ clipboard?: string }> {
    if (input.kind === 'pointer-exit') {
      // Preserve keyboard focus and held keys. A captured drag leaves only after
      // its release, so this event must never terminate a held host gesture.
      if (!this.buttons.size) await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: -1, y: -1, button: 'none', buttons: 0,
      });
    } else if (input.kind === 'pointer') {
      if (input.type === 'down') this.buttons.set(input.button, input);
      else if (input.type === 'up') this.buttons.delete(input.button);
      else
        for (const [button, held] of this.buttons)
          this.buttons.set(button, { ...held, x: input.x, y: input.y });
      await this.cdp.send('Input.dispatchMouseEvent', {
        type:
          input.type === 'down'
            ? 'mousePressed'
            : input.type === 'up'
              ? 'mouseReleased'
              : 'mouseMoved',
        x: input.x,
        y: input.y,
        button: input.button,
        buttons: input.buttons,
        clickCount: input.clicks,
        modifiers: input.modifiers,
      });
    } else if (input.kind === 'wheel')
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        modifiers: input.modifiers,
      });
    else if (input.kind === 'key') {
      const id = input.code || input.key;
      const repeat = this.keys.has(id);
      if (input.type === 'down') {
        if (this.keys.size >= 128 && !repeat)
          throw new Error('Too many pressed keys');
        this.keys.set(id, input);
      } else this.keys.delete(id);
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: input.type === 'down' ? 'keyDown' : 'keyUp',
        key: input.key,
        code: input.code,
        windowsVirtualKeyCode: input.keyCode,
        modifiers: input.modifiers,
        autoRepeat: input.type === 'down' && repeat,
        ...(input.type === 'down' && (input.text !== undefined || input.key === 'Enter')
          ? { text: input.text ?? '\r' }
          : {}),
      });
    } else if (input.kind === 'composition') {
      this.composing = !!input.text;
      await this.cdp.send('Input.imeSetComposition', {
        text: input.text,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
      });
    } else if (input.kind === 'text') {
      await this.page.keyboard.insertText(input.text);
      this.composing = false;
    } else if (input.kind === 'edit')
      await this.edit(input.operation === 'undo' ? 'Undo' : 'Redo');
    else if (input.operation === 'selectAll') await this.edit('SelectAll');
    else if (input.operation === 'copy' || input.operation === 'cut') {
      const frame = await this.focusedFrame();
      current();
      const text = await frame.evaluate(() => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
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
      if (input.operation === 'cut' && text)
        await this.page.keyboard.press('Backspace');
      return text ? { clipboard: text } : {};
    } else throw new Error('Paste must be provided by the viewing device');
    return {};
  }

  private async focusedFrame() {
    let frame = this.page.mainFrame();
    // Focus follows nested cross-origin frames through Playwright, without
    // exposing a frame evaluator or page content to the agent/renderer bridge.
    for (let depth = 0; depth < 20; depth++) {
      const element = await frame.evaluateHandle(() => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return active;
      });
      try {
        const next = await element.asElement()?.contentFrame();
        if (!next) return frame;
        frame = next;
      } finally {
        await element.dispose();
      }
    }
    throw new Error('Focused browser frame limit reached');
  }
}
