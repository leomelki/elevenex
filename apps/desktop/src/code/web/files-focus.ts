/** The public extension API reports active editors, not focus returning to the
 * same editor. Adapt native tree activation/focus inside the pinned host;
 * no selectors, events or command dispatcher cross into the app renderer. */
export class FilesFocus {
  private browsing = false;
  private readonly focused = (event: FocusEvent) => {
    if (!this.browsing || !(event.target instanceof Element) || !event.target.closest('.monaco-editor')) return;
    this.accept();
  };
  private readonly clicked = (event: MouseEvent) => {
    if (!this.browsing || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
    if (event.target.closest('input,textarea,button,[role="button"]')) return;
    const row = event.target.closest('[role="treeitem"]');
    // Folder rows expose expansion state; activating one continues browsing.
    if (row && !row.hasAttribute('aria-expanded')) this.accept();
  };
  private accept(): void { this.browsing = false; void this.returnToEditor().catch(() => undefined); }
  constructor(private readonly document: Document, private readonly returnToEditor: () => Promise<unknown>) {
    document.addEventListener('focusin', this.focused);
    document.addEventListener('click', this.clicked);
  }
  setBrowsing(value: boolean): void { this.browsing = value; }
  dispose(): void { this.document.removeEventListener('focusin', this.focused); this.document.removeEventListener('click', this.clicked); this.browsing = false; }
}
