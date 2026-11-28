import type { IDisposable, Terminal } from '@xterm/xterm';

/** Keep xterm 6's accessibility selection within the terminal that owns the DOM range. */
export function enableTerminalAccessibility(terminal: Terminal, document: Document): IDisposable {
  const registration = Object.getOwnPropertyDescriptor(document, 'addEventListener');
  const addEventListener = document.addEventListener;
  const controller = new AbortController();
  let rows: Element | null | undefined;

  // xterm clamps even ranges whose two endpoints are outside its accessibility
  // tree. Wrap its synchronous registration so chat and panel selections
  // cannot overwrite terminal output selection. Keep other DOM listeners intact.
  document.addEventListener = new Proxy(addEventListener, {
    apply(register, receiver, args: Parameters<Document['addEventListener']>) {
      const [type, listener] = args;
      if (type !== 'selectionchange' || typeof listener !== 'function') {
        Reflect.apply(register, receiver, args);
        return;
      }
      addEventListener.call(document, type, event => {
        if (!rows?.isConnected) return;
        const selection = document.getSelection();
        if (selection && (rows.contains(selection.anchorNode) || rows.contains(selection.focusNode)))
          listener.call(document, event);
      }, { signal: controller.signal });
    },
  });
  try {
    terminal.options.screenReaderMode = true;
    rows = terminal.element?.querySelector('.xterm-accessibility-tree');
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    if (registration) Object.defineProperty(document, 'addEventListener', registration);
    else Reflect.deleteProperty(document, 'addEventListener');
  }
  return { dispose: () => controller.abort() };
}
