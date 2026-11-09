import type { WebContents, MouseInputEvent, KeyboardInputEvent } from 'electron';

/** Synchronous Electron dispatch distinguishes our input from a real user's
 * before-input hooks. Never mark an asynchronous CDP interval as synthetic. */
export class AgentNativeInput {
  private readonly buttons = new Set<'left' | 'right' | 'middle'>();
  private readonly keys = new Set<string>();
  private point = { x: 0, y: 0 };
  constructor(private readonly contents: WebContents, private readonly dispatch: (input: MouseInputEvent | KeyboardInputEvent | Electron.MouseWheelInputEvent) => void) {}
  send(method: string, params: Record<string, unknown>): Promise<unknown> | null {
    const modifiers: NonNullable<KeyboardInputEvent['modifiers']> = [];
    const mask = Number(params['modifiers'] ?? 0);
    for (const [bit, name] of [[1, 'alt'], [2, 'control'], [4, 'meta'], [8, 'shift']] as const) if (mask & bit) modifiers.push(name);
    if (method === 'Input.dispatchMouseEvent') {
      const x = Number(params['x']), y = Number(params['y']);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) throw new Error('Invalid input coordinates');
      const zoom = this.contents.getZoomFactor();
      this.point = { x: Math.round(x * zoom), y: Math.round(y * zoom) };
      if (params['type'] === 'mouseWheel') {
        const deltaX = Number(params['deltaX'] ?? 0), deltaY = Number(params['deltaY'] ?? 0);
        if (![deltaX, deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) throw new Error('Invalid wheel delta');
        this.dispatch({ type: 'mouseWheel', ...this.point, deltaX, deltaY, modifiers, canScroll: true });
      } else {
        const type = params['type'] === 'mousePressed' ? 'mouseDown' : params['type'] === 'mouseReleased' ? 'mouseUp' : params['type'] === 'mouseMoved' ? 'mouseMove' : null;
        if (!type) throw new Error('Invalid mouse event');
        const button = params['button'] ?? 'left';
        if (button !== 'left' && button !== 'right' && button !== 'middle' && button !== 'none') throw new Error('Unsupported mouse button');
        if (type === 'mouseDown' && button !== 'none') this.buttons.add(button);
        if (type === 'mouseUp' && button !== 'none') this.buttons.delete(button);
        this.dispatch({ type, ...this.point, ...(button === 'none' ? {} : { button }), clickCount: Number(params['clickCount'] ?? 1), modifiers });
      }
      return Promise.resolve({});
    }
    if (method === 'Input.dispatchKeyEvent') {
      const type = params['type'] === 'keyUp' ? 'keyUp' : params['type'] === 'keyDown' || params['type'] === 'rawKeyDown' ? 'keyDown' : params['type'] === 'char' ? 'char' : null;
      const key = params['key'] ?? params['text'];
      if (!type || typeof key !== 'string' || key.length > 64) throw new Error('Invalid key event');
      const keyCode = ({ ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' } as Record<string, string>)[key] ?? key;
      if (type === 'keyDown') this.keys.add(keyCode); else if (type === 'keyUp') this.keys.delete(keyCode);
      this.dispatch({ type, keyCode, modifiers });
      if (type === 'keyDown' && typeof params['text'] === 'string' && params['text'] !== '') this.dispatch({ type: 'char', keyCode: params['text'], modifiers });
      return Promise.resolve({});
    }
    if (method === 'Input.insertText') {
      if (typeof params['text'] !== 'string' || params['text'].length > 65536) throw new Error('Invalid text input');
      return this.contents.insertText(params['text']).then(() => ({}));
    }
    return null;
  }
  release(): void {
    if (this.contents.isDestroyed()) return;
    for (const button of this.buttons) this.dispatch({ type: 'mouseUp', ...this.point, button });
    for (const keyCode of this.keys) this.dispatch({ type: 'keyUp', keyCode });
    this.buttons.clear(); this.keys.clear();
  }
}
