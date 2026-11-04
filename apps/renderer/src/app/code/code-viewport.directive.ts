import { DOCUMENT } from '@angular/common';
import { afterNextRender, afterRenderEffect, DestroyRef, Directive, ElementRef, inject, input, output, signal } from '@angular/core';
import { codeBlendDelay, codeDestinationWidth, supportsCodeTransition } from './code-view-transition';

/** Resize the live viewport once, then stretch its compositor image with the
 * shell's glide. Blend layouts after a child-layout acknowledgement.
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
    let blendAncestor: HTMLElement | undefined;
    let blurHold = 0;
    const snapshotAnimations = () => (scope.getAnimations?.({subtree: true}) ?? []).filter(animation =>
      // Angular prefixes component keyframes in production builds.
      'animationName' in animation && typeof animation.animationName === 'string'
      && (animation.animationName.endsWith('code-layout-out') || animation.animationName.endsWith('code-layout-in')));
    const stopBlurHold = () => { window.cancelAnimationFrame(blurHold); blurHold = 0; };
    const holdBlurUntilReady = () => {
      blurHold = 0;
      if (!snapshot || snapshotAcknowledged) return;
      const animations = snapshotAnimations();
      const first = animations[0];
      const timing = first?.effect?.getComputedTiming();
      if (first && timing && typeof timing.duration === 'number' && typeof first.currentTime === 'number'
        && first.currentTime >= (timing.delay ?? 0) + timing.duration / 2) {
        // Blur on the shell clock; keep the old image opaque at the midpoint
        // until the real child is ready. No unblurred layout can leak through.
        for (const animation of animations) {
          animation.pause(); animation.currentTime = (timing.delay ?? 0) + timing.duration / 2;
        }
      } else blurHold = window.requestAnimationFrame(holdBlurUntilReady);
    };
    const playSnapshots = () => {
      const delay = blendAncestor ? codeBlendDelay(blendAncestor) : 0;
      for (const animation of snapshotAnimations()) {
        animation.effect?.updateTiming({ delay });
        animation.play();
      }
      if (!snapshotAcknowledged) blurHold = window.requestAnimationFrame(holdBlurUntilReady);
    };

    const cancelSnapshot = () => {
      generation++;
      stopBlurHold();
      snapshot?.skipTransition();
      snapshot = undefined;
      snapshotReady = false;
      snapshotAcknowledged = false;
      blendAncestor = undefined;
      preparedWidth = 0;
      this.frame.style.removeProperty('transform');
      this.frame.classList.remove('crossfading');
    };

    const cancelReveal = () => {
      window.cancelAnimationFrame(reveal);
      reveal = 0;
    };

    const measure = () => {
      const next = viewport.clientWidth;
      if (frozenWidth && preparedWidth && next > 0) {
        // Transform only the outer compositor surface: the cross-origin child
        // keeps its destination viewport while the original shell CSS glides.
        // Before snapshot capture completes, width is still the old viewport.
        this.frame.style.transform = `scaleX(${next / width})`;
      }
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
        this.frame.style.removeProperty('transform');
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
        stopBlurHold();
        if (snapshotReady) for (const animation of snapshotAnimations()) {
          if (animation.playState === 'paused') animation.play();
        }
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
        if (reduced.matches || width <= 0 || this.frame.hidden) return;
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
          if (destination === width) {
            // Sliding a panel over its retained viewport is not an editor
            // resize. Keep Code visible from the very first opening frame.
            transitions.delete(ancestor);
            frozenWidth = 0;
            this.frame.classList.remove('resizing', 'reflowing', 'cover-immediate');
            return;
          }
          if (destination && supportsCodeTransition(scope)) {
            const version = generation;
            preparedWidth = destination;
            blendAncestor = ancestor;
            this.frame.classList.add('crossfading');
            const transition = scope.startViewTransition(async () => {
              if (version !== generation) return;
              // Lay out at the destination immediately, behind the old native
              // snapshot. Main's compact commands now overlap the panel glide.
              this.frame.style.width = `${destination}px`;
              this.frame.style.transform = `scaleX(${viewport.clientWidth / destination})`;
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
              // Begin the blur one third into the glide. Its opaque midpoint
              // waits for acknowledgement before fading into the ready image.
              for (const animation of snapshotAnimations()) {
                animation.pause(); animation.currentTime = 0;
              }
              playSnapshots();
            }).catch(() => { if (snapshot === transition) this.frame.classList.add('reflowing'); });
            void transition.finished.finally(() => {
              if (snapshot !== transition) return;
              stopBlurHold();
              snapshot = undefined;
              this.frame.classList.remove('crossfading', 'reflowing', 'cover-immediate');
            }).catch(() => undefined);
          } else this.frame.classList.add('reflowing');
        }
      } else {
        if (!transitions.delete(ancestor)) return;
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
