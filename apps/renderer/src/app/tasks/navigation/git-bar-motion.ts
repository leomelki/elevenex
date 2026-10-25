import type { AnimationCallbackEvent } from "@angular/core";

interface GitBarVisibility {
  readonly action: boolean;
  readonly stat: boolean;
}

/** Owns only GitBar's measured slots and ink. The component owns Git state and intents. */
export class GitBarMotion {
  private observer?: ResizeObserver;
  private motion?: MediaQueryList;
  private initialized = false;
  private destroyed = false;
  private visibility: GitBarVisibility = { action: false, stat: false };
  private actionVisible = false;
  private statVisible = false;
  private readonly animations = new Set<Animation>();
  private readonly widths = new Map<HTMLElement, Animation>();
  private readonly fades = new Map<HTMLElement, Animation>();
  private readonly countWidths = new Map<HTMLElement, number>();
  private readonly preferenceChanged = (): void => {
    if (!this.motion?.matches) return;
    for (const animation of this.animations) animation.cancel();
    this.layout(false);
  };

  constructor(private readonly root: HTMLElement) {}

  initialize(visibility: GitBarVisibility): void {
    this.visibility = visibility;
    this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    this.motion.addEventListener?.("change", this.preferenceChanged);
    this.layout(false);
    this.initialized = true;
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.layout(true));
      for (const measure of this.root.querySelectorAll(".measure"))
        this.observer.observe(measure);
    }
  }

  update(visibility: GitBarVisibility): void {
    this.visibility = visibility;
    if (this.initialized) this.layout(true);
  }

  destroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    this.motion?.removeEventListener?.("change", this.preferenceChanged);
    for (const animation of this.animations) animation.cancel();
  }

  /** Read intrinsic sizes before resizing the bounded slots and count badges. */
  private layout(animate: boolean): void {
    if (this.destroyed) return;
    const primary = this.root.querySelector<HTMLButtonElement>(".primary");
    const more = this.root.querySelector<HTMLButtonElement>(".more");
    const actionSlot = this.root.querySelector<HTMLElement>(".action-slot");
    const statSlot = this.root.querySelector<HTMLElement>(".stat-slot");
    const actionMeasure =
      this.root.querySelector<HTMLElement>(".action-measure");
    const statMeasure = this.root.querySelector<HTMLElement>(".stat-measure");
    if (
      !primary ||
      !more ||
      !actionSlot ||
      !statSlot ||
      !actionMeasure ||
      !statMeasure
    )
      return;
    const style = getComputedStyle(primary);
    // Intrinsic copies inherit from the bar, so copy the button's keyboard-hint
    // spacing instead of duplicating a button style in GitBar's stylesheet.
    const keyboardMargin = style.getPropertyValue("--kbd-margin");
    if (actionMeasure.style.getPropertyValue("--kbd-margin") !== keyboardMargin)
      actionMeasure.style.setProperty("--kbd-margin", keyboardMargin);
    const move = animate && !this.motion?.matches;
    // The DOM already contains the new digits here. Keep the previous layout
    // width, or the current painted width when interrupted, as the origin.
    const counts = new Set(
      [...this.root.querySelectorAll<HTMLElement>(".rolling")].filter(
        (element) => !element.closest(".leaving"),
      ),
    );
    for (const element of this.countWidths.keys()) {
      if (!counts.has(element)) this.countWidths.delete(element);
    }
    const countTargets = [...counts].map((element) => {
      const content = element.querySelector<HTMLElement>("span:not(.leaving)");
      const countStyle = getComputedStyle(element);
      const width =
        (content?.getBoundingClientRect().width ?? 0) +
        [
          countStyle.paddingLeft,
          countStyle.paddingRight,
          countStyle.borderLeftWidth,
          countStyle.borderRightWidth,
        ].reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
      return {
        element,
        width,
        from: this.widths.has(element)
          ? element.getBoundingClientRect().width
          : (this.countWidths.get(element) ?? width),
        initialized: this.countWidths.has(element),
      };
    });
    const primaryWidth =
      actionMeasure.getBoundingClientRect().width +
      [
        style.paddingLeft,
        style.paddingRight,
        style.borderLeftWidth,
        style.borderRightWidth,
      ].reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
    const showAction = this.visibility.action;
    const showStat = this.visibility.stat;
    const actionWidth = actionSlot.getBoundingClientRect().width;
    const targets = [
      {
        element: primary,
        width: primaryWidth,
        // A reopening slot can still contain a visible, partially closed pill.
        moving: showAction && (this.actionVisible || actionWidth > 0.5),
        closing: false,
      },
      {
        element: actionSlot,
        width: showAction
          ? primaryWidth + more.getBoundingClientRect().width
          : 0,
        moving: true,
        closing: !showAction,
      },
      {
        element: statSlot,
        width: showStat
          ? statMeasure.getBoundingClientRect().width +
            (showAction
              ? parseFloat(style.getPropertyValue("--space-2")) || 0
              : 0)
          : 0,
        moving: true,
        closing: !showStat,
      },
    ].map((target) => ({
      ...target,
      from: target.element.getBoundingClientRect().width,
    }));
    for (const target of countTargets) {
      this.countWidths.set(target.element, target.width);
      this.resize(
        target.element,
        target.from,
        target.width,
        move && target.initialized,
        false,
        style,
      );
    }
    for (const target of targets)
      this.resize(
        target.element,
        target.from,
        target.width,
        move && target.moving,
        target.closing,
        style,
      );
    if (!animate || showAction !== this.actionVisible) {
      for (const ink of this.root.querySelectorAll<HTMLElement>(
        ".action-content, .chevron-ink",
      ))
        this.reveal(ink, showAction, move, style);
    }
    if (!animate || showStat !== this.statVisible) {
      const ink = this.root.querySelector<HTMLElement>(".stat-content");
      if (ink) this.reveal(ink, showStat, move, style);
    }
    this.actionVisible = showAction;
    this.statVisible = showStat;
  }

  private resize(
    element: HTMLElement,
    from: number,
    to: number,
    animate: boolean,
    closing: boolean,
    style: CSSStyleDeclaration,
  ): void {
    if (animate && parseFloat(element.style.width) === to) return;
    this.widths.get(element)?.cancel();
    element.style.width = `${to}px`;
    element.classList.toggle("settled", !animate && to > 0);
    if (!animate || Math.abs(from - to) < 0.5 || !element.animate) {
      element.classList.toggle("settled", to > 0);
      return;
    }
    const frames: Keyframe[] = closing
      ? [
          { width: `${from}px`, offset: 0 },
          {
            width: `${from}px`,
            offset: 0.28,
            easing: style.getPropertyValue("--ease-in-out").trim(),
          },
          { width: `${to}px`, offset: 1 },
        ]
      : [{ width: `${from}px` }, { width: `${to}px` }];
    const animation = this.play(
      element,
      frames,
      {
        duration: parseFloat(style.getPropertyValue("--dur-slow")) || 0,
        easing: closing
          ? "linear"
          : style.getPropertyValue("--ease-in-out").trim() || "linear",
      },
      () => {
        if (this.widths.get(element) !== animation) return;
        this.widths.delete(element);
        element.classList.toggle(
          "settled",
          parseFloat(element.style.width) > 0,
        );
      },
    );
    this.widths.set(element, animation);
  }

  private reveal(
    element: HTMLElement,
    show: boolean,
    animate: boolean,
    style: CSSStyleDeclaration,
  ): void {
    const current = getComputedStyle(element);
    const from = { opacity: current.opacity, transform: current.transform };
    this.fades.get(element)?.cancel();
    element.style.opacity = show ? "1" : "0";
    element.style.transform = show ? "none" : "translateX(4px)";
    if (!animate || !element.animate) return;
    const animation = this.play(
      element,
      [
        from,
        { opacity: show ? 1 : 0, transform: show ? "none" : "translateX(4px)" },
      ],
      {
        duration:
          parseFloat(
            style.getPropertyValue(show ? "--dur-fast" : "--dur-instant"),
          ) || 0,
        delay: show ? parseFloat(style.getPropertyValue("--dur-fast")) || 0 : 0,
        easing:
          style.getPropertyValue(show ? "--ease-out" : "--ease-in").trim() ||
          "linear",
        fill: "backwards",
      },
      () => {
        if (this.fades.get(element) === animation) this.fades.delete(element);
      },
    );
    this.fades.set(element, animation);
  }

  leaveInk(event: AnimationCallbackEvent): void {
    if (this.destroyed) {
      event.animationComplete();
      return;
    }
    const element = event.target;
    const style = getComputedStyle(element);
    const from = {
      opacity: style.opacity,
      transform: style.transform,
      filter: style.filter,
    };
    element.setAttribute("inert", "");
    element.setAttribute("aria-hidden", "true");
    element.classList.add("leaving");
    for (const animation of element.getAnimations()) animation.cancel();
    if (
      this.motion?.matches ||
      !element.animate ||
      parseFloat(from.opacity) < 0.01
    ) {
      event.animationComplete();
      return;
    }
    this.play(
      element,
      [
        from,
        { opacity: 0, transform: "translateY(-4px)", filter: "blur(2px)" },
      ],
      {
        duration: parseFloat(style.getPropertyValue("--dur-fast")) || 0,
        easing: style.getPropertyValue("--ease-in").trim() || "linear",
      },
      event.animationComplete,
    );
  }

  leaveMenu(event: AnimationCallbackEvent, done: () => void): void {
    const element = event.target;
    element.setAttribute('inert', '');
    element.setAttribute('aria-hidden', 'true');
    const style = getComputedStyle(element);
    const from = { opacity: style.opacity, transform: style.transform };
    for (const animation of element.getAnimations()) animation.cancel();
    if (this.destroyed || this.motion?.matches || !element.animate) { done(); return; }
    this.play(element, [from, { opacity: 0, transform: 'translateY(4px) scale(.98)' }], {
      duration: parseFloat(style.getPropertyValue('--dur-fast')) || 140,
      easing: style.getPropertyValue('--ease-in').trim() || 'ease-in',
    }, done);
  }

  private play(
    element: Element,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
    done: () => void,
  ): Animation {
    const animation = element.animate(frames, options);
    this.animations.add(animation);
    animation.onfinish = animation.oncancel = () => {
      this.animations.delete(animation);
      done();
    };
    return animation;
  }
}
