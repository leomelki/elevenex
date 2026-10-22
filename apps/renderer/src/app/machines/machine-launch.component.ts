import { afterRenderEffect, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, input, output, viewChild } from '@angular/core';

/** Owns the transition only. Both projected views stay mounted; the hidden one is inert. */
@Component({
  selector: 'ex-machine-launch',
  templateUrl: './machine-launch.component.html',
  styleUrl: './machine-launch.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineLaunchComponent {
  readonly open = input(false);
  readonly machineId = input<string | null>(null);
  readonly transitionFinished = output<boolean>();
  protected readonly host = viewChild<ElementRef<HTMLElement>>('host');
  protected readonly home = viewChild<ElementRef<HTMLElement>>('home');
  protected readonly pane = viewChild<ElementRef<HTMLElement>>('pane');
  protected readonly zoom = viewChild<ElementRef<HTMLElement>>('zoom');
  protected readonly faces = viewChild<ElementRef<HTMLElement>>('faces');
  private previous?: boolean;
  private lastMachine: string | null = null;
  private animations: Animation[] = [];
  private generation = 0;
  private returnFocus?: HTMLElement;
  private launchingCard?: HTMLElement;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancel());
    afterRenderEffect(() => {
      const opening = this.open();
      const machine = this.machineId();
      if (machine) this.lastMachine = machine;
      const was = this.previous;
      this.previous = opening;
      if (was === undefined || was === opening) return;
      this.animate(opening);
    });
  }

  private cancel(): void {
    this.generation++;
    this.animations.forEach(animation => animation.cancel());
    this.animations = [];
    this.faces()?.nativeElement.replaceChildren();
    if (this.launchingCard) this.launchingCard.style.visibility = '';
    this.launchingCard = undefined;
  }

  private animate(opening: boolean): void {
    this.cancel();
    const host = this.host()?.nativeElement;
    const pane = this.pane()?.nativeElement;
    const zoom = this.zoom()?.nativeElement;
    const home = this.home()?.nativeElement;
    if (!host || !pane || !zoom || !home) return;
    const card = Array.from(home.querySelectorAll<HTMLElement>('[data-machine]')).find(element => element.dataset['machine'] === this.lastMachine);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 140 : opening ? 560 : 500;
    const options: KeyframeAnimationOptions = { duration, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };
    if (!card || reduced) {
      this.animations = [pane.animate(opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], options)];
    } else {
      // Cover-fit the view throughout: a non-uniform scale would stretch the app's text.
      const outer = host.getBoundingClientRect();
      const origin = card.getBoundingClientRect();
      const left = origin.left - outer.left;
      const top = origin.top - outer.top;
      const width = outer.width;
      const height = outer.height;
      const radius = Number.parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0;
      if (!width || !height) return;
      const paneFrames: Keyframe[] = [];
      const viewFrames: Keyframe[] = [];
      const faceFrames: Keyframe[] = [];
      for (let index = 0; index <= 14; index++) {
        const fraction = index / 14;
        const value = opening ? fraction : 1 - fraction;
        const x = left * (1 - value);
        const y = top * (1 - value);
        const w = origin.width + (width - origin.width) * value;
        const h = origin.height + (height - origin.height) * value;
        const scale = Math.max(w / width, h / height);
        paneFrames.push({ offset: fraction, visibility: 'visible', clipPath: `inset(${y}px ${width - x - w}px ${height - y - h}px ${x}px round ${radius * (1 - value)}px)` });
        viewFrames.push({ offset: fraction, transform: `translate(${x + w / 2 - width * scale / 2}px, ${y + h / 2 - height * scale / 2}px) scale(${scale})`, opacity: Math.min(1, value / .45) });
        faceFrames.push({ offset: fraction, transform: `translate(${x - left}px, ${y - top}px) scale(${w / origin.width}, ${h / origin.height})`, opacity: Math.max(0, 1 - value / .5) });
      }
      this.animations = [pane.animate(paneFrames, options), zoom.animate(viewFrames, options), home.animate(opening ? [{ transform: 'scale(1)', filter: 'blur(0)' }, { transform: 'scale(1.04)', filter: 'blur(4px)' }] : [{ transform: 'scale(1.04)', filter: 'blur(4px)' }, { transform: 'scale(1)', filter: 'blur(0)' }], options)];
      const face = card.cloneNode(true);
      if (face instanceof HTMLElement) {
        face.removeAttribute('data-machine');
        face.removeAttribute('id');
        face.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
        face.inert = true;
        face.setAttribute('aria-hidden', 'true');
        Object.assign(face.style, { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${origin.width}px`, height: `${origin.height}px`, transformOrigin: '0 0', pointerEvents: 'none', margin: '0' });
        this.faces()?.nativeElement.appendChild(face);
        this.launchingCard = card;
        card.style.visibility = 'hidden';
        this.animations.push(face.animate(faceFrames, options));
      }
    }
    if (opening && home.contains(document.activeElement) && document.activeElement instanceof HTMLElement) this.returnFocus = document.activeElement;
    const generation = this.generation;
    void Promise.all(this.animations.map(animation => animation.finished)).then(() => {
      if (generation !== this.generation) return;
      this.faces()?.nativeElement.replaceChildren();
      if (this.launchingCard) this.launchingCard.style.visibility = '';
      this.launchingCard = undefined;
      if (opening) pane.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')?.focus({ preventScroll: true });
      else (this.returnFocus?.isConnected ? this.returnFocus : card)?.focus({ preventScroll: true });
      this.transitionFinished.emit(opening);
    }).catch(() => { /* Reversing or destroying a launch cancels its owned animations. */ });
  }
}
