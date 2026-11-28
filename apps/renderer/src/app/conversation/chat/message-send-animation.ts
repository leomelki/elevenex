import type { MessageSendOrigin } from '../conversation.models';

/** One mounted message owns its transient, inaccessible flight copy and effects. */
export function animateMessageSend(message: HTMLElement, origin?: MessageSendOrigin): () => void {
  const style = getComputedStyle(message);
  const out = style.getPropertyValue('--ease-out').trim() || 'ease-out';
  const glide = style.getPropertyValue('--ease-glide').trim() || 'ease-out';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animations: Animation[] = [];
  let copy: HTMLElement | undefined;
  let frame: number | undefined;
  const visibility = message.style.visibility;
  const restore = () => {
    message.style.visibility = visibility;
    copy?.remove();
    copy = undefined;
  };
  const cleanup = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    for (const animation of animations.splice(0)) {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    }
    restore();
  };
  if (!message.animate) return cleanup;
  const content = message.querySelector<HTMLElement>('.content');
  const freshOrigin = origin && performance.now() - origin.at >= 0 && performance.now() - origin.at < 800;
  if (reduced || !freshOrigin || !content || message.offsetHeight > 160) {
    const animation = message.animate(reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: 'translateY(14px) scale(.96)' }, { opacity: 1, transform: 'none' }],
    { duration: reduced ? 160 : 340, easing: reduced ? out : glide });
    animations.push(animation);
    animation.onfinish = cleanup;
    animation.oncancel = cleanup;
    return cleanup;
  }
  const bubble = message.getBoundingClientRect();
  const text = content.getBoundingClientRect();
  const clone = message.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return cleanup;
  copy = clone;
  copy.classList.remove('fresh');
  copy.classList.add('send-flight');
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  copy.removeAttribute('id');
  copy.removeAttribute('data-user-message');
  copy.removeAttribute('tabindex');
  for (const element of copy.querySelectorAll('[id]')) element.removeAttribute('id');
  copy.querySelector('time')?.remove();
  Object.assign(copy.style, {
    position: 'fixed', zIndex: '1000', pointerEvents: 'none', margin: '0',
    boxSizing: 'border-box', maxWidth: 'none', font: style.font,
    left: `${bubble.left}px`, top: `${bubble.top}px`, width: `${bubble.width}px`, height: `${bubble.height}px`,
  });
  message.ownerDocument.body.appendChild(copy);
  message.style.visibility = 'hidden';
  const travel = copy.animate([
    { transform: `translate(${origin.left - text.left}px, ${origin.top - text.top}px)` },
    { transform: 'translate(0, 0)' },
  ], { duration: 380, easing: glide });
  // Scroll makes room while the words travel. Rebase the same effect to the
  // current destination without restarting its clock or moving its source.
  const effect = travel.effect;
  if (typeof KeyframeEffect !== 'undefined' && effect instanceof KeyframeEffect) {
    const insetLeft = text.left - bubble.left;
    const insetTop = text.top - bubble.top;
    let previous = bubble;
    const followDestination = () => {
      frame = undefined;
      if (!copy) return;
      const rect = message.getBoundingClientRect();
      if (rect.left !== previous.left || rect.top !== previous.top ||
          rect.width !== previous.width || rect.height !== previous.height) {
        Object.assign(copy.style, {
          left: `${rect.left}px`, top: `${rect.top}px`,
          width: `${rect.width}px`, height: `${rect.height}px`,
        });
        effect.setKeyframes([
          { transform: `translate(${origin.left - rect.left - insetLeft}px, ${origin.top - rect.top - insetTop}px)` },
          { transform: 'translate(0, 0)' },
        ]);
        previous = rect;
      }
      frame = requestAnimationFrame(followDestination);
    };
    frame = requestAnimationFrame(followDestination);
  }
  animations.push(travel, copy.animate([
    { backgroundColor: 'transparent', borderColor: 'transparent', boxShadow: 'none' },
    { offset: .6, backgroundColor: style.backgroundColor, borderColor: style.borderColor },
    { backgroundColor: style.backgroundColor, borderColor: style.borderColor, boxShadow: style.boxShadow },
  ], { duration: 380, easing: 'ease-in-out' }));
  travel.onfinish = cleanup;
  travel.oncancel = cleanup;
  return cleanup;
}
