import { DOCUMENT } from '@angular/common';
import { afterNextRender, afterRenderEffect, DestroyRef, Directive, ElementRef, inject, input, output, signal } from '@angular/core';
import { codeDestinationWidth, supportsCodeTransition } from './code-view-transition';

/** Keep text at its natural scale while the shell glides. Cover the retained
 * viewport, resize once underneath, then reveal after a child-layout acknowledgement.
 * Ordinary window resizing remains live. No iframe is recreated. */
@Directive({ selector: '[exCodeViewport]' })
export class CodeViewportDirective {
  readonly viewportWidth = output<number>();
  readonly layoutRequested = output<void>();
  readonly layoutReady = input(true);
  readonly contextKey = input('');
  private readonly settlement = signal(0);
  private revealWhenReady?: () => void;
  private resetContext?: () => void;
  private previousContext?: string;
  private readonly frame = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly document = inject(DOCUMENT);

  constructor() {
    let dispose: (() => void) | undefined;
    afterNextRender(() => { dispose = this.observe(); });
    afterRenderEffect(() => {
      const context = this.contextKey();
      if (this.previousContext !== undefined && this.previousContext !== context) this.resetContext?.();
      this.previousContext = context;
      this.settlement();
      if (this.layoutReady()) this.revealWhenReady?.();
    });
    inject(DestroyRef).onDestroy(() => dispose?.());
  }

  private observe(): () => void {
    const viewport = this.frame.parentElement;
    const window = this.document.defaultView;
    if (!viewport || !window) return () => undefined;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const layoutOwner = this.frame.closest<HTMLElement>('[data-panel-transition-scope]');
    // Keep panel actions outside the snapshot's hit-test boundary.
    const scope = this.frame;
    const transitions = new Set<HTMLElement>();
    let width = viewport.clientWidth;
    let frozenWidth = 0;
    let pending = 0;
    let reveal = 0;
    let awaitingLayout = false;
    let snapshot: ViewTransition | undefined;
    let preparedWidth = 0;
    let generation = 0;
    let snapshotReady = false;
    let snapshotAcknowledged = false;
    const snapshotAnimations = () => (scope.getAnimations?.({subtree: true}) ?? []).filter(animation =>
      // Angular prefixes component keyframes in production builds.
      'animationName' in animation && typeof animation.animationName === 'string'
      && (animation.animationName.endsWith('code-layout-out') || animation.animationName.endsWith('code-layout-in')));

    const cancelSnapshot = () => {
      generation++;
      snapshot?.skipTransition();
      snapshot = undefined;
      snapshotReady = false;
      snapshotAcknowledged = false;
      preparedWidth = 0;
      this.frame.classList.remove('crossfading');
      scope.classList.remove('panel-layout-transition');
    };

    const cancelReveal = () => {
      window.cancelAnimationFrame(reveal);
      reveal = 0;
    };

    const measure = () => {
      const next = viewport.clientWidth;
      if (!frozenWidth && next > 0) {
        width = next;
        // Keep the child at an explicit settled width even between toggles.
        // Chromium can publish the first CSS width step before transitionrun.
        this.frame.style.width = `${width}px`;
        this.viewportWidth.emit(width);
      }
    };
    const release = () => {
      if (preparedWidth && Math.abs(viewport.clientWidth - preparedWidth) <= 1) {
        frozenWidth = 0;
        this.frame.classList.remove('resizing');
        measure();
        return;
      }
      // A native window resize can change a percentage destination mid-glide.
      // Reconcile that exceptional size under an immediate cover, not a flash.
      if (preparedWidth) this.frame.classList.add('reflowing', 'cover-immediate');
      cancelSnapshot();
      frozenWidth = 0;
      this.frame.classList.remove('resizing');
      measure();
      cancelReveal();
      awaitingLayout = true;
      this.layoutRequested.emit();
      this.settlement.update(value => value + 1);
    };
    this.revealWhenReady = () => {
      if (!awaitingLayout || reveal) return;
      if (snapshot && preparedWidth) {
        awaitingLayout = false;
        snapshotAcknowledged = true;
        if (snapshotReady) for (const animation of snapshotAnimations()) animation.play();
        return;
      }
      if (frozenWidth) return;
      // Main acknowledges the expected child viewport, upstream compact-mode
      // commands and quiet workbench geometry before the reveal can begin.
      reveal = window.requestAnimationFrame(() => {
        reveal = 0;
        awaitingLayout = false;
        this.frame.classList.remove('reflowing', 'cover-immediate');
      });
    };
    const changed = (event: Event) => {
      const ancestor = event.target;
      // Listen on the document because transition events do not travel down to
      // projected content. Unrelated widths, opacity and nested effects cannot
      // hold the editor's viewport. No shell-private selectors are needed.
      if (!('propertyName' in event) || event.propertyName !== 'width' || !(ancestor instanceof HTMLElement) || ancestor === this.frame || !ancestor.contains(viewport)) return;
      if (event.type === 'transitionrun') {
        // Use the last settled measurement: reading layout here would flush
        // the first animated width into the child before we can freeze it.
        if (reduced.matches || width <= 0) return;
        transitions.add(ancestor);
        if (preparedWidth) { cancelSnapshot(); frozenWidth = 0; }
        if (!frozenWidth && width > 0) {
          cancelReveal();
          cancelSnapshot();
          awaitingLayout = false;
          frozenWidth = width;
          this.frame.style.width = `${width}px`;
          this.frame.classList.add('resizing');
          const destination = typeof KeyframeEffect === 'undefined' ? null : codeDestinationWidth(ancestor, viewport);
          if (destination && destination !== width && supportsCodeTransition(scope)) {
            const version = generation;
            preparedWidth = destination;
            this.frame.classList.add('crossfading');
            scope.classList.add('panel-layout-transition');
            const transition = scope.startViewTransition(async () => {
              if (version !== generation) return;
              // Lay out at the destination immediately, behind the old native
              // snapshot. Main's compact commands now overlap the panel glide.
              this.frame.style.width = `${destination}px`;
              layoutOwner?.dispatchEvent(new Event('panel-layout-commit'));
              width = destination;
              this.viewportWidth.emit(width);
              awaitingLayout = true;
              this.layoutRequested.emit();
              this.settlement.update(value => value + 1);
              // Return immediately so Chromium can propagate the new iframe
              // viewport. Holding this callback would suppress that layout.
            });
            snapshot = transition;
            void transition.ready.then(() => {
              if (snapshot !== transition) return;
              snapshotReady = true;
              // Keep the old browser snapshot opaque while the new live image
              // renders underneath. Release both animations together on ack.
              for (const animation of snapshotAnimations()) {
                animation.pause(); animation.currentTime = 0;
                if (snapshotAcknowledged) animation.play();
              }
            }).catch(() => { if (snapshot === transition) this.frame.classList.add('reflowing'); });
            void transition.finished.finally(() => {
              if (snapshot !== transition) return;
              snapshot = undefined;
              this.frame.classList.remove('crossfading', 'reflowing', 'cover-immediate');
              scope.classList.remove('panel-layout-transition');
            }).catch(() => undefined);
          } else this.frame.classList.add('reflowing');
        }
      } else {
        transitions.delete(ancestor);
        window.cancelAnimationFrame(pending);
        // A reversal cancels one transition and starts its replacement in the
        // same rendering update. Keep the original viewport through that pair.
        pending = window.requestAnimationFrame(() => {
          pending = 0;
          if (!transitions.size) release();
        });
      }
    };
    const motionChanged = () => {
      if (!reduced.matches) return;
      transitions.clear();
      cancelSnapshot();
      window.cancelAnimationFrame(pending);
      pending = 0;
      release();
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    this.resetContext = () => {
      transitions.clear();
      window.cancelAnimationFrame(pending); pending = 0;
      cancelReveal(); cancelSnapshot();
      frozenWidth = 0; awaitingLayout = false;
      this.frame.classList.remove('resizing', 'reflowing', 'cover-immediate');
      measure();
    };
    observer?.observe(viewport);
    measure();
    for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) this.document.addEventListener(type, changed, true);
    reduced.addEventListener('change', motionChanged);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(pending);
      cancelReveal();
      cancelSnapshot();
      this.revealWhenReady = undefined;
      this.resetContext = undefined;
      for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) this.document.removeEventListener(type, changed, true);
      reduced.removeEventListener('change', motionChanged);
      this.frame.style.removeProperty('width');
      this.frame.classList.remove('resizing', 'reflowing', 'cover-immediate');
    };
  }
}
