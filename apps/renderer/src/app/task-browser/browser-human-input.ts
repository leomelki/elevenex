import type { TaskBrowserStreamEvent } from '@elevenex/shared';

/** DOM gestures and composition for a streamed page; transport authority stays with the owner. */
export class BrowserHumanInput {
  private composing = false;
  private readonly heldKeys = new Map<
    string,
    Extract<TaskBrowserStreamEvent, { kind: 'key' }>
  >();
  private heldPointer?: Extract<TaskBrowserStreamEvent, { kind: 'pointer' }>;
  private lastClick?: {
    time: number;
    x: number;
    y: number;
    button: number;
    count: number;
  };
  private committedComposition?: string;
  private compositionTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly send: (input: TaskBrowserStreamEvent) => void,
    private readonly textarea: () => HTMLTextAreaElement | undefined,
    private readonly point: (
      event: MouseEvent,
    ) => { x: number; y: number } | null,
    private readonly pageHeight: () => number,
    private readonly shortcut: (intent: 'open' | 'pick' | 'controls') => void,
  ) {}
  clear(): void {
    this.heldKeys.clear();
    this.heldPointer = undefined;
    this.lastClick = undefined;
    this.composing = false;
    this.committedComposition = undefined;
    clearTimeout(this.compositionTimer);
    this.clearText();
  }
  destroy(): void {
    this.releaseInput();
    this.clear();
  }
  pointer(event: PointerEvent, type: 'down' | 'up' | 'move'): void {
    event.stopPropagation();
    event.preventDefault();
    if (type !== 'move' && event.button > 2) return;
    const point = this.point(event);
    if (!point) return;
    if (type === 'down') {
      this.textarea()?.focus({ preventScroll: true });
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      const previous = this.lastClick;
      this.lastClick = {
        time: event.timeStamp,
        ...point,
        button: event.button,
        count:
          previous &&
          previous.button === event.button &&
          event.timeStamp - previous.time < 500 &&
          Math.hypot(previous.x - point.x, previous.y - point.y) < 4
            ? (previous.count % 3) + 1
            : 1,
      };
    }
    const input: Extract<TaskBrowserStreamEvent, { kind: 'pointer' }> = {
      kind: 'pointer',
      type,
      ...point,
      button:
        type === 'move'
          ? event.buttons & 1
            ? 'left'
            : event.buttons & 2
              ? 'right'
              : event.buttons & 4
                ? 'middle'
                : 'none'
          : event.button === 2
            ? 'right'
            : event.button === 1
              ? 'middle'
              : 'left',
      buttons: event.buttons,
      // PointerEvent.detail is zero in Chromium, including a double click.
      clicks: type === 'move' ? 0 : (this.lastClick?.count ?? 1),
      modifiers: this.modifiers(event),
    };
    this.heldPointer = event.buttons ? input : undefined;
    this.send(input);
  }
  cancelPointer(): void {
    const pointer = this.heldPointer;
    this.heldPointer = undefined;
    if (pointer)
      this.send({ ...pointer, type: 'up', buttons: 0, modifiers: 0 });
  }
  releaseInput(): void {
    this.cancelPointer();
    for (const key of this.heldKeys.values())
      this.send({ ...key, type: 'up', modifiers: 0 });
    this.heldKeys.clear();
    if (this.composing)
      this.send({
        kind: 'composition',
        text: '',
        selectionStart: 0,
        selectionEnd: 0,
      });
    this.composing = false;
    this.clearText();
  }
  wheel(event: WheelEvent): void {
    event.stopPropagation();
    event.preventDefault();
    const point = this.point(event);
    if (!point) return;
    const scale =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? this.pageHeight()
          : 1;
    this.send({
      kind: 'wheel',
      ...point,
      deltaX: Math.max(-10000, Math.min(10000, event.deltaX * scale)),
      deltaY: Math.max(-10000, Math.min(10000, event.deltaY * scale)),
      modifiers: this.modifiers(event),
    });
  }
  key(event: KeyboardEvent, type: 'down' | 'up'): void {
    event.stopPropagation();
    if (event.isComposing || this.composing) return;
    // Let the local input method turn dead/process keys into composition or text.
    if (event.key === 'Dead' || event.key === 'Process' || event.keyCode === 229)
      return;
    const key = event.key.toLowerCase();
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      (key === 'z' || key === 'y')
    ) {
      event.preventDefault();
      if (type === 'down')
        this.send({
          kind: 'edit',
          operation: key === 'y' || event.shiftKey ? 'redo' : 'undo',
        });
      return;
    }
    if (
      (event.shiftKey && event.key === 'Escape') ||
      ((event.metaKey || event.ctrlKey) && !event.altKey &&
        (event.key.toLowerCase() === 't' ||
          (event.shiftKey && event.key.toLowerCase() === 'c')))
    ) {
      event.preventDefault();
      if (type === 'down') {
        this.shortcut(
          event.key === 'Escape'
            ? 'controls'
            : event.key.toLowerCase() === 't'
              ? 'open'
              : 'pick',
        );
      }
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      ['c', 'v', 'x', 'a'].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      if (type === 'down')
        this.send({
          kind: 'clipboard',
          operation:
            event.key.toLowerCase() === 'c'
              ? 'copy'
              : event.key.toLowerCase() === 'v'
                ? 'paste'
                : event.key.toLowerCase() === 'x'
                  ? 'cut'
                  : 'selectAll',
        });
      return;
    }
    // Printable characters arrive through beforeinput, including composed Unicode.
    if (
      event.key.length !== 1 ||
      (event.ctrlKey && !event.altKey) ||
      event.metaKey
    )
      event.preventDefault();
    const input: Extract<TaskBrowserStreamEvent, { kind: 'key' }> = {
      kind: 'key',
      type,
      key: event.key,
      code: event.code,
      keyCode: Math.min(255, event.keyCode),
      modifiers: this.modifiers(event),
    };
    const identity = event.code || event.key;
    if (type === 'down') {
      if (this.heldKeys.size < 128 || this.heldKeys.has(identity))
        this.heldKeys.set(identity, input);
    } else this.heldKeys.delete(identity);
    this.send(input);
  }
  beforeInput(event: Event): void {
    event.stopPropagation();
    const input = event as InputEvent;
    if (this.composing || input.isComposing) return;
    event.preventDefault();
    if (input.inputType === 'historyUndo' || input.inputType === 'historyRedo')
      this.send({
        kind: 'edit',
        operation: input.inputType === 'historyUndo' ? 'undo' : 'redo',
      });
    if (
      input.inputType === 'insertText' &&
      input.data &&
      input.data !== this.committedComposition
    )
      this.send({ kind: 'text', text: input.data });
  }
  compositionStart(): void {
    clearTimeout(this.compositionTimer);
    this.committedComposition = undefined;
    this.composing = true;
  }
  compositionUpdate(event: CompositionEvent): void {
    if (!this.composing || event.data.length > 4096) return;
    this.send({
      kind: 'composition',
      text: event.data,
      selectionStart: event.data.length,
      selectionEnd: event.data.length,
    });
  }
  compositionEnd(event: CompositionEvent): void {
    if (!this.composing) return;
    this.composing = false;
    // insertText commits the existing Chromium composition. An empty update cancels it.
    this.send(
      event.data
        ? { kind: 'text', text: event.data }
        : { kind: 'composition', text: '', selectionStart: 0, selectionEnd: 0 },
    );
    this.committedComposition = event.data;
    clearTimeout(this.compositionTimer);
    this.compositionTimer = setTimeout(() => {
      this.committedComposition = undefined;
    }, 0);
    this.clearText();
  }
  clearText(): void {
    if (!this.composing) {
      const element = this.textarea();
      if (element) element.value = '';
    }
  }
  private modifiers(event: MouseEvent | KeyboardEvent): number {
    return (
      Number(event.altKey) |
      (Number(event.ctrlKey) << 1) |
      (Number(event.metaKey) << 2) |
      (Number(event.shiftKey) << 3)
    );
  }
}
