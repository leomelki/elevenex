/** Runs only inside the owned Code frame, before/after upstream compact commands.
 * Renderer paint frames cannot establish that an out-of-process workbench has
 * received its viewport or finished its own animated grid/configuration work. */
export function waitForCodeLayout(expectedWidth: number, viewportOnly = false): Promise<void> {
  return new Promise((resolve, reject) => {
    if (viewportOnly && Math.abs(innerWidth - expectedWidth) <= 1) { resolve(); return; }
    let frame = 0;
    let previous = '';
    let stableFrames = 0;
    const dispose = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      window.removeEventListener('pagehide', closed);
      document.removeEventListener('elevenex-code-layout-cancel', cancelled);
    };
    const cancelled = () => { dispose(); resolve(); };
    const closed = () => { dispose(); reject(new Error('The editor closed while resizing.')); };
    const timeout = setTimeout(() => { dispose(); reject(new Error('The editor layout did not settle.')); }, 2000);
    const sample = () => {
      if (viewportOnly && Math.abs(innerWidth - expectedWidth) <= 1) { dispose(); resolve(); return; }
      const workbench = document.querySelector('.monaco-workbench');
      const parts = workbench ? Array.from(workbench.querySelectorAll('.part, .monaco-editor')).slice(0, 32) : [];
      const geometry = JSON.stringify([innerWidth, ...parts.map(part => {
        const box = part.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height];
      })]);
      const moving = workbench?.getAnimations({ subtree: true }).some(animation =>
        animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)
        && animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(keyframe =>
          Object.keys(keyframe).some(key => /^(width|height|minWidth|maxWidth|minHeight|maxHeight|left|right|top|bottom|transform|flex|grid|margin|padding)/.test(key))));
      if (geometry !== previous || moving || !workbench || Math.abs(innerWidth - expectedWidth) > 1) stableFrames = 0;
      else stableFrames++;
      previous = geometry;
      // Commands have completed. Confirm two stable child paints without adding
      // a fixed quiet-time delay to every user-initiated layout change.
      if (stableFrames >= 2) { dispose(); resolve(); }
      else frame = requestAnimationFrame(sample);
    };
    window.addEventListener('pagehide', closed, { once: true });
    document.addEventListener('elevenex-code-layout-cancel', cancelled, { once: true });
    frame = requestAnimationFrame(sample);
  });
}
