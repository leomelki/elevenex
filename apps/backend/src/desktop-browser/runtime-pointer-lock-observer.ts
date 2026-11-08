/** Runs only in our CDP isolated world. Site scripts cannot replace its getter or binding. */
export function pointerLockObserver(binding: string): void {
  const notify: unknown = Reflect.get(globalThis, binding);
  if (typeof notify !== 'function') return;
  if (typeof Reflect.get(globalThis, binding + 'Authorize') === 'function')
    return;
  let sequence = 0;
  let ticket = '';
  const report = (change: boolean) => {
    if (ticket)
      Reflect.apply(notify, globalThis, [
        JSON.stringify({
          locked: document.pointerLockElement !== null,
          sequence: ++sequence,
          change,
          ticket,
        }),
      ]);
  };
  const changed = (event: Event) => {
    if (event.isTrusted) report(true);
  };
  // Capture at Window before site listeners can stop propagation at an ancestor.
  window.addEventListener('pointerlockchange', changed, true);
  Reflect.set(globalThis, binding + 'Authorize', (value: string) => {
    ticket = value;
    report(false);
  });
  Reflect.set(globalThis, binding + 'Read', (expected: string) => {
    if (expected !== ticket) throw new Error('Pointer lock observer changed');
    report(false);
  });
  Reflect.set(globalThis, binding + 'Exit', (expected: string) => {
    if (expected !== ticket) return;
    if (document.pointerLockElement) document.exitPointerLock();
    report(false);
  });
  Reflect.set(globalThis, binding + 'Stop', (expected?: string) => {
    if (expected !== undefined && expected !== ticket) return;
    window.removeEventListener('pointerlockchange', changed, true);
    Reflect.deleteProperty(globalThis, binding + 'Read');
    Reflect.deleteProperty(globalThis, binding + 'Stop');
    Reflect.deleteProperty(globalThis, binding + 'Authorize');
    Reflect.deleteProperty(globalThis, binding + 'Exit');
  });
  report(false);
}
