import type { BrowserWindow } from 'electron';
import { choiceProgram, controllerProgram, PROMPT_WIDTH, renderProgram } from './webauthn-prompt-document';
import { promptChoice, type PromptChoice, type PromptView } from './webauthn-prompt-view';

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 520;

/** Drives the sheet inside one ceremony window. The window's owner (the broker)
 * creates and destroys it; destroying it rejects every pending call here. */
export class WebAuthnPrompt {
  private shown = false;
  private accounts = 0;
  constructor(private readonly window: BrowserWindow) {}

  async install(): Promise<void> { await this.execute(controllerProgram()); }

  /** Writes a phase, fits the window to it and shows the window on first use.
   * On macOS the sheet's height eases natively between phases. */
  async render(view: PromptView): Promise<void> {
    const height = await this.execute(renderProgram(view));
    if (typeof height !== 'number' || !Number.isFinite(height)) throw new Error('Authentication prompt unavailable');
    if (this.window.isDestroyed()) throw new Error('Authentication prompt closed');
    this.accounts = view.accounts.length;
    this.window.setContentSize(PROMPT_WIDTH, Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)), this.shown);
    if (!this.shown) { this.shown = true; this.window.show(); this.window.focus(); }
  }

  /** The next choice made in the sheet. Every pending caller receives the same
   * choice; a closed window reads as Cancel. */
  async choice(): Promise<PromptChoice> {
    return promptChoice(await this.execute(choiceProgram()).catch(() => 'cancel'), this.accounts);
  }

  private execute(code: string): Promise<unknown> {
    if (this.window.isDestroyed()) return Promise.reject(new Error('Authentication prompt closed'));
    return this.window.webContents.executeJavaScript(code);
  }
}
