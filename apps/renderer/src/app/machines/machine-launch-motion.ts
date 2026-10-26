export interface LaunchRect { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
interface LaunchElements { readonly host: HTMLElement; readonly home: HTMLElement; readonly pane: HTMLElement; readonly zoom: HTMLElement; readonly faces: HTMLElement }

/** Read before Angular updates/reflows Home. Coordinates are in unscaled host units. */
export function measureLaunchRect(host: HTMLElement, card: HTMLElement): LaunchRect {
  const outer = host.getBoundingClientRect(), origin = card.getBoundingClientRect();
  const scale = (host.offsetWidth ? outer.width / host.offsetWidth : 1) || 1;
  return { left: (origin.left - outer.left) / scale, top: (origin.top - outer.top) / scale, width: origin.width / scale, height: origin.height / scale };
}

/** Owns the box, cover-fit view, Home and cloned face on one interruptible curve. */
export class MachineLaunchMotion {
  private readonly media = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly reducedChanged = () => { if (this.media.matches) this.animations.forEach(animation => animation.finish()); };
  private animations: Animation[] = [];
  private generation = 0;
  private restoreCard?: () => void;
  private currentRect?: LaunchRect;
  private range: readonly [number, number] = [0, 1];

  constructor(private readonly elements: LaunchElements) { this.media.addEventListener('change', this.reducedChanged); }

  async play(opening: boolean, card?: HTMLElement, from?: LaunchRect): Promise<boolean> {
    const progress = this.animations[0]?.effect?.getComputedTiming().progress;
    const value = progress == null ? opening ? 0 : 1 : this.range[0] + (this.range[1] - this.range[0]) * progress;
    const interruptedRect = progress == null ? undefined : this.currentRect;
    this.cancel();
    const generation = this.generation;
    const { host, pane, zoom, home, faces } = this.elements;
    if (!pane.animate) return true;
    const options: KeyframeAnimationOptions = { duration: this.media.matches ? parseFloat(getComputedStyle(host).getPropertyValue('--dur-fast')) || 140 : opening ? 560 : 500, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'both' };
    if (!card || this.media.matches) {
      this.animations = [pane.animate(opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], options)];
    } else {
      const origin = interruptedRect ?? from ?? measureLaunchRect(host, card);
      this.currentRect = origin; this.range = [value, opening ? 1 : 0];
      const { left, top } = origin, width = host.offsetWidth, height = host.offsetHeight;
      if (!width || !height || !origin.width || !origin.height) return true;
      home.style.transformOrigin = `${left + origin.width / 2}px ${top + origin.height / 2 + home.scrollTop}px`;
      const radius = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0;
      const cardColor = getComputedStyle(card).backgroundColor, appColor = getComputedStyle(pane).backgroundColor;
      const paneFrames: Keyframe[] = [], viewFrames: Keyframe[] = [], faceFrames: Keyframe[] = [];
      for (let index = 0; index <= 14; index++) {
        const fraction = index / 14, p = value + ((opening ? 1 : 0) - value) * fraction;
        const x = left * (1 - p), y = top * (1 - p), w = origin.width + (width - origin.width) * p, h = origin.height + (height - origin.height) * p;
        const scale = Math.max(w / width, h / height), faceScale = Math.min(w / origin.width, h / origin.height);
        paneFrames.push({ offset: fraction, opacity: !opening && index === 14 ? 0 : 1, backgroundColor: p < .35 ? cardColor : appColor, clipPath: `inset(${y}px ${width - x - w}px ${height - y - h}px ${x}px round ${radius * faceScale * Math.min(1, 2 * (1 - p)) + .01}px)` });
        viewFrames.push({ offset: fraction, transform: `translate(${x + w / 2 - width * scale / 2}px, ${y + h / 2 - height * scale / 2}px) scale(${scale})`, opacity: Math.max(0, Math.min(1, (p - .18) / .4)) });
        faceFrames.push({ offset: fraction, transform: `translate(${x - left}px, ${y - top}px) scale(${w / origin.width}, ${h / origin.height})`, opacity: Math.max(0, Math.min(1, 1 - (p - .12) / .38)) });
      }
      this.animations = [pane.animate(paneFrames, options), zoom.animate(viewFrames, options), home.animate([{ transform: `scale(${1 + .06 * value})`, filter: `blur(${3 * value}px)`, opacity: 1 - value }, { transform: opening ? 'scale(1.06)' : 'scale(1)', filter: opening ? 'blur(3px)' : 'blur(0)', opacity: opening ? 0 : 1 }], options)];
      const face = card.cloneNode(true);
      if (face instanceof HTMLElement) {
        face.removeAttribute('data-machine'); face.classList.remove('highlighted', 'pressed'); face.removeAttribute('id');
        face.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
        face.inert = true; face.setAttribute('aria-hidden', 'true');
        Object.assign(face.style, { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${origin.width}px`, height: `${origin.height}px`, transformOrigin: '0 0', pointerEvents: 'none', margin: '0', transition: 'none', boxShadow: 'var(--shadow-pop), inset 0 0 0 1px var(--line)' });
        faces.appendChild(face);
        const visibility = card.style.visibility;
        this.restoreCard = () => { card.style.visibility = visibility; };
        card.style.visibility = 'hidden'; this.animations.push(face.animate(faceFrames, options));
      }
    }
    try { await Promise.all(this.animations.map(animation => animation.finished)); }
    catch { return false; }
    if (generation !== this.generation) return false;
    this.cancel(); return true;
  }

  dispose(): void { this.cancel(); this.media.removeEventListener('change', this.reducedChanged); }
  private cancel(): void {
    this.generation++; this.animations.forEach(animation => animation.cancel()); this.animations = [];
    this.elements.faces.replaceChildren(); this.restoreCard?.(); this.restoreCard = undefined;
  }
}
