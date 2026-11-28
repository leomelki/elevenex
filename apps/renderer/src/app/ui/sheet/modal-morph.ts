export interface ModalBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

export const MODAL_LAUNCH_EASING = 'cubic-bezier(.32,.72,0,1)';

/** Cover-fit the dialog inside a travelling box; only the disposable face stretches. */
export function modalMorphFrames(origin: ModalBox, dialog: ModalBox, start: number, end: number, fadeIn = 0): {
  surface: Keyframe[]; content: Keyframe[]; face: Keyframe[]; shadow: Keyframe[];
} {
  const surface: Keyframe[] = [], content: Keyframe[] = [], face: Keyframe[] = [], shadow: Keyframe[] = [];
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  for (let index = 0; index <= 14; index++) {
    const offset = index / 14, p = start + (end - start) * offset;
    const width = origin.width + (dialog.width - origin.width) * p;
    const height = origin.height + (dialog.height - origin.height) * p;
    const x = origin.left + (dialog.left - origin.left) * p;
    const y = origin.top + (dialog.top - origin.top) * p;
    const scale = Math.max(width / dialog.width, height / dialog.height);
    const insetX = (dialog.width - width / scale) / 2, insetY = (dialog.height - height / scale) / 2;
    const radius = origin.radius + (dialog.radius - origin.radius) * p;
    const visible = end === 0 && index === 14 ? 0 : 1;
    surface.push({ offset, transform: `translate(${x + width / 2 - dialog.left - dialog.width / 2}px, ${y + height / 2 - dialog.top - dialog.height / 2}px) scale(${scale})`, clipPath: `inset(${insetY}px ${insetX}px round ${radius / scale}px)`, opacity: visible * (fadeIn ? clamp(p / fadeIn) : 1) });
    content.push({ offset, opacity: clamp((p - .18) / .4) });
    face.push({ offset, transform: `translate(${x - origin.left}px, ${y - origin.top}px) scale(${width / origin.width}, ${height / origin.height})`, opacity: clamp(1 - (p - .12) / .38) });
    shadow.push({ offset, transform: `translate(${x - dialog.left}px, ${y - dialog.top}px) scale(${width / dialog.width}, ${height / dialog.height})`, opacity: clamp((p - .1) / .5) * visible });
  }
  return { surface, content, face, shadow };
}

/** Coordinates belong to the overlay, which can itself be inside a scaled preview. */
export function measureModalOrigin(layer: HTMLElement, element: HTMLElement, mode: 'painted' | 'resting' = 'painted'): ModalBox {
  const outer = layer.getBoundingClientRect(), rect = element.getBoundingClientRect();
  let left = rect.left, top = rect.top, width = rect.width, height = rect.height;
  if (mode === 'resting') {
    const boundary = element.closest('[data-modal-window], .ex-window, ex-app-shell');
    // Unwind entry/press/recession transforms within this window. The return
    // meets the card after Home comes forward, including a card still growing in.
    for (let node: HTMLElement | null = element; node && node !== boundary; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (!style.transform || style.transform === 'none') continue;
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (matrix.b || matrix.c || matrix.a <= 0 || matrix.d <= 0 || !node.offsetWidth || !node.offsetHeight) continue;
      const box = node.getBoundingClientRect();
      const [originX, originY] = style.transformOrigin.split(' ').map(Number.parseFloat);
      const outerX = box.width / node.offsetWidth / matrix.a, outerY = box.height / node.offsetHeight / matrix.d;
      const restingLeft = box.left - ((originX ?? 0) * (1 - matrix.a) + matrix.e) * outerX;
      const restingTop = box.top - ((originY ?? 0) * (1 - matrix.d) + matrix.f) * outerY;
      left = restingLeft + (left - box.left) / matrix.a;
      top = restingTop + (top - box.top) / matrix.d;
      width /= matrix.a; height /= matrix.d;
    }
  }
  const scale = (layer.offsetWidth ? outer.width / layer.offsetWidth : 1) || 1;
  return { left: (left - outer.left) / scale, top: (top - outer.top) / scale, width: width / scale, height: height / scale, radius: parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0 };
}

/** Visual copies are outside Angular's view tree and must never acquire focus or duplicate identities. */
export function copyModalFace(element: HTMLElement): HTMLElement {
  const face = element.cloneNode(true);
  if (!(face instanceof HTMLElement)) throw new Error('A modal origin must be an HTML element');
  for (const node of [face, ...face.querySelectorAll('*')]) {
    for (const attribute of ['id', 'autofocus', 'data-machine', 'data-grid-key', 'data-key']) node.removeAttribute(attribute);
  }
  face.classList.remove('highlighted', 'pressed', 'is-hi', 'is-press');
  face.classList.add('ex-modal-face');
  face.inert = true;
  face.setAttribute('aria-hidden', 'true');
  face.setAttribute('tabindex', '-1');
  // Component-scoped card styles can outweigh overlay CSS, so these ownership
  // properties are explicit on the copy (the original keeps all its styles).
  Object.assign(face.style, { position: 'absolute', margin: '0', transformOrigin: '0 0', pointerEvents: 'none', transition: 'none', opacity: '', transform: '', zIndex: '2', visibility: 'visible' });
  return face;
}
