import type { ProjectHue } from '../tasks/task.models';

export interface JumpHomeOptions {
  readonly peak?: number;
  readonly grow?: number;
  readonly scale?: number;
  readonly text?: string;
  readonly shadow?: boolean;
  readonly dur?: number;
  readonly delay?: number;
  readonly ny?: number;
  readonly landed?: (target: HTMLElement) => void;
}
function offset(element: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let current: HTMLElement | null = element;
  while (current && current !== root) { x += current.offsetLeft; y += current.offsetTop; current = current.offsetParent instanceof HTMLElement ? current.offsetParent : null; }
  return { x, y };
}
function flightProgress(x: number): number {
  if (x <= 0 || x >= 1) return x;
  const at = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let low = 0;
  let high = 1;
  let time = x;
  for (let iteration = 0; iteration < 40; iteration++) {
    const value = at(time, .4, .2);
    if (Math.abs(value - x) < .00001) break;
    if (value < x) low = time; else high = time;
    time = (low + high) / 2;
  }
  return at(time, 0, 1);
}
/** One bell-shaped arc, exactly as the supplied reference. The owner cancels
 * the returned animation on navigation/destruction; cancellation removes the
 * copy and restores the landing target without firing a stale landed intent. */
export function jumpHome(root: HTMLElement, from: HTMLElement, to: HTMLElement, options: JumpHomeOptions = {}): Animation | null {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  if (motion.matches || !from.animate || !to.animate || !root.contains(from) || !root.contains(to)) { options.landed?.(to); return null; }
  const source = offset(from, root);
  let width = from.offsetWidth;
  const height = from.offsetHeight;
  let ghost: HTMLElement;
  if (from instanceof HTMLInputElement) {
    const style = getComputedStyle(from);
    ghost = document.createElement('span');
    ghost.textContent = options.text ?? from.value;
    Object.assign(ghost.style, { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, letterSpacing: style.letterSpacing, lineHeight: `${height}px`, color: style.color, whiteSpace: 'nowrap' });
    root.appendChild(ghost);
    width = ghost.offsetWidth;
    source.x += parseFloat(style.paddingLeft) || 0;
  } else {
    const copy = from.cloneNode(true);
    if (!(copy instanceof HTMLElement)) return null;
    ghost = copy;
    root.appendChild(ghost);
  }
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.removeAttribute('id');
  for (const descendant of ghost.querySelectorAll('[id]')) descendant.removeAttribute('id');
  Object.assign(ghost.style, { position: 'absolute', visibility: 'visible', margin: '0', left: `${source.x}px`, top: `${source.y}px`, width: `${width}px`, height: `${height}px`, transformOrigin: '0 0', zIndex: '60', pointerEvents: 'none' });
  const target = offset(to, root);
  const scale = options.scale ?? to.offsetWidth / Math.max(1, width);
  const grow = options.grow ?? .4;
  const startX = source.x + width / 2;
  const startY = source.y + height / 2;
  const deltaX = target.x + width * scale / 2 - startX;
  const deltaY = target.y + height * scale / 2 + (options.ny || 0) - startY;
  const size = (progress: number) => (1 + (scale - 1) * progress) * (1 + grow * 4 * progress * (1 - progress));
  const centerY = (progress: number, arc: number) => startY + deltaY * progress - 4 * arc * progress * (1 - progress);
  const top = (arc: number) => {
    let minimum = Infinity;
    for (let index = 0; index <= 60; index++) minimum = Math.min(minimum, centerY(index / 60, arc) - height * size(index / 60) / 2);
    return minimum;
  };
  const peak = options.peak ?? 4;
  let low = 0;
  let high = 2000;
  let arc = 0;
  if (top(0) > peak) for (let iteration = 0; iteration < 40; iteration++) { arc = (low + high) / 2; if (top(arc) > peak) low = arc; else high = arc; }
  const frames: Keyframe[] = [];
  for (let index = 0; index <= 90; index++) {
    const time = index / 90;
    const progress = flightProgress(time);
    const currentScale = size(progress);
    const bell = 4 * progress * (1 - progress);
    frames.push({ offset: time, transform: `translate(${(startX + deltaX * progress - width * currentScale / 2 - source.x).toFixed(2)}px,${(centerY(progress, arc) - height * currentScale / 2 - source.y).toFixed(2)}px) scale(${currentScale.toFixed(4)})`, opacity: time > .94 ? Math.max(0, (1 - time) / .06) : 1, ...(options.shadow === false ? {} : { filter: `drop-shadow(0 ${(2 + 16 * bell).toFixed(1)}px ${(4 + 22 * bell).toFixed(1)}px rgba(10,20,40,${(.08 + .2 * bell).toFixed(3)}))` }) });
  }
  const duration = options.dur ?? 1000;
  const delay = options.delay ?? 0;
  const previousOpacity = to.style.opacity;
  to.style.opacity = '0';
  const flight = ghost.animate(frames, { duration, delay, easing: 'linear', fill: 'both' });
  const landing = to.animate([{ opacity: 0 }, { opacity: 1 }], { duration: Math.max(1, duration * .06), delay: delay + duration * .94, easing: 'linear', fill: 'both' });
  let settled = false;
  const cleanup = (landed: boolean) => {
    if (settled) return;
    settled = true;
    ghost.remove();
    motion.removeEventListener('change', stopForReducedMotion);
    landing.cancel();
    to.style.opacity = previousOpacity;
    if (landed && to.isConnected) options.landed?.(to);
  };
  const nativeCancel = flight.cancel.bind(flight);
  // Native cancel events arrive asynchronously. Restore ownership synchronously
  // so a replacement flight cannot inherit an old hidden destination.
  flight.cancel = () => { cleanup(false); nativeCancel(); };
  const stopForReducedMotion = () => { if (motion.matches) { cleanup(true); nativeCancel(); } };
  motion.addEventListener('change', stopForReducedMotion);
  flight.onfinish = () => cleanup(true);
  flight.oncancel = () => cleanup(false);
  return flight;
}
/** Squash, spring and one soft hue ring. The returned disposer owns both
 * animations and restores the target's original transform origin. */
export function settleMark(root: HTMLElement, element: HTMLElement, hue: ProjectHue = 'steel'): () => void {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  if (motion.matches || !element.animate) return () => undefined;
  const previousOrigin = element.style.transformOrigin;
  element.style.transformOrigin = '50% 100%';
  const squash = element.animate([{ transform: 'scale(1.16,.84)' }, { transform: 'scale(.93,1.07)', offset: .38 }, { transform: 'scale(1.03,.98)', offset: .7 }, { transform: 'scale(1)' }], { duration: 480, easing: 'cubic-bezier(.2,.7,.3,1)' });
  const point = offset(element, root);
  const ring = document.createElement('span');
  ring.setAttribute('aria-hidden', 'true');
  Object.assign(ring.style, { position: 'absolute', zIndex: '55', borderRadius: 'var(--radius-md)', pointerEvents: 'none', boxShadow: '0 0 0 2px currentColor', left: `${point.x - 4}px`, top: `${point.y - 4}px`, width: `${element.offsetWidth + 8}px`, height: `${element.offsetHeight + 8}px`, color: `var(--project-${hue})` });
  root.appendChild(ring);
  const ripple = ring.animate([{ transform: 'scale(.85)', opacity: .8 }, { transform: 'scale(1.55)', opacity: 0 }], { duration: 620, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
  const cleanup = () => { ring.remove(); element.style.transformOrigin = previousOrigin; motion.removeEventListener('change', stopForReducedMotion); };
  const dispose = () => { squash.cancel(); ripple.cancel(); cleanup(); };
  const stopForReducedMotion = () => { if (motion.matches) dispose(); };
  motion.addEventListener('change', stopForReducedMotion);
  squash.onfinish = () => { element.style.transformOrigin = previousOrigin; };
  ripple.onfinish = cleanup;
  ripple.oncancel = cleanup;
  return dispose;
}
