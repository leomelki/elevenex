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
  // Opening/closing an ordinary panel clips a minimum-width inner surface.
  // Its negative gap cannot predict an actual workbench resize.
  if (gap < 0) return null;
  const width = Math.round(pixels - gap);
  return width > 0 && width <= 20_000 ? width : null;
}
