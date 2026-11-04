/** Runs only inside the owned Code frame, after upstream compact commands.
 * Renderer paint frames cannot establish that an out-of-process workbench has
 * received its viewport or finished its own animated grid/configuration work. */
export function waitForCodeLayout(expectedWidth: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    let previous = '';
    let quietSince = performance.now();
    const dispose = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      window.removeEventListener('pagehide', closed);
      document.removeEventListener('elevenex-code-layout-cancel', cancelled);
    };
    const cancelled = () => { dispose(); resolve(); };
    const closed = () => { dispose(); reject(new Error('The editor closed while resizing.')); };
    const timeout = setTimeout(() => { dispose(); reject(new Error('The editor layout did not settle.')); }, 2000);
    const sample = (now: number) => {
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
      if (geometry !== previous || moving || !workbench || Math.abs(innerWidth - expectedWidth) > 1) quietSince = now;
      previous = geometry;
      // Covers delayed configuration/layout notifications after command promises
      // resolve, and samples actual child geometry throughout native transitions.
      if (now - quietSince >= 120) { dispose(); resolve(); }
      else frame = requestAnimationFrame(sample);
    };
    window.addEventListener('pagehide', closed, { once: true });
    document.addEventListener('elevenex-code-layout-cancel', cancelled, { once: true });
    frame = requestAnimationFrame(sample);
  });
}
