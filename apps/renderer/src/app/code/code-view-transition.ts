/** The locked Chromium supports scoped transitions; TypeScript's DOM library
 * does not declare them yet. Feature detection preserves the covered fallback.
 * Browser-owned snapshots never expose cross-origin editor pixels to scripts.
 * https://developer.chrome.com/docs/css-ui/view-transitions/element-scoped-view-transitions */
interface ScopedTransitionElement extends HTMLElement {
  startViewTransition(update: () => Promise<void>): ViewTransition;
}

export function supportsCodeTransition(element: HTMLElement): element is ScopedTransitionElement {
  return 'startViewTransition' in element && typeof element.startViewTransition === 'function';
}

/** Freeze the iframe before calling: reading animated ancestor layout otherwise
 * flushes a small intermediate viewport into the expensive child document. */
export function codeDestinationWidth(ancestor: HTMLElement, viewport: HTMLElement): number | null {
  const transition = ancestor.getAnimations?.().find(animation => 'transitionProperty' in animation && animation.transitionProperty === 'width');
  if (!(transition?.effect instanceof KeyframeEffect)) return null;
  const destination = transition.effect.getKeyframes().at(-1)?.['width'];
  if (typeof destination !== 'string') return null;
  let pixels: number;
  if (/^\d+(?:\.\d+)?px$/.test(destination)) pixels = Number.parseFloat(destination);
  else if (/^\d+(?:\.\d+)?%$/.test(destination) && ancestor.offsetParent instanceof HTMLElement) {
    pixels = ancestor.offsetParent.clientWidth * Number.parseFloat(destination) / 100;
  } else if (ancestor.offsetParent instanceof HTMLElement && CSS.supports('width', destination)) {
    // Responsive panel widths can retain min()/vw expressions in keyframes.
    // Resolve them in their real containing block without changing the panel.
    const probe = ancestor.ownerDocument.createElement('div');
    probe.inert = true;
    Object.assign(probe.style, {position:'absolute',visibility:'hidden',pointerEvents:'none',width:destination,height:'0',padding:'0',border:'0'});
    ancestor.offsetParent.append(probe);
    try { pixels = probe.clientWidth; } finally { probe.remove(); }
  } else return null;
  const gap = ancestor.clientWidth - viewport.clientWidth;
  // Ordinary opening/closing clips a minimum-width inner surface without
  // resizing Code. Return that unchanged viewport so it stays visible.
  if (gap < 0 || pixels === 0) return viewport.clientWidth;
  const width = Math.round(pixels - gap);
  return width > 0 && width <= 20_000 ? width : null;
}

/** Snapshot animation uses the panel's native clock, including shortened
 * reversal durations. Sharing startTime keeps compositor frames synchronized. */
export function codeTransitionClock(ancestor: HTMLElement): { duration: number; elapsed: number; startTime: number | null } {
  const transition = ancestor.getAnimations?.().find(animation => 'transitionProperty' in animation && animation.transitionProperty === 'width');
  const duration = transition?.effect?.getComputedTiming().duration;
  return {
    duration: typeof duration === 'number' ? duration : 0,
    elapsed: typeof transition?.currentTime === 'number' ? transition.currentTime : 0,
    startTime: typeof transition?.startTime === 'number' ? transition.startTime : null,
  };
}
