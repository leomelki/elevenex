/** Self-contained renderer callback: serialized into the page without Node imports. */
export function inspectPage(selectors) {
  const element = node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { tag: node.tagName.toLowerCase(), text: node.textContent?.trim().slice(0, 2000),
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      style: Object.fromEntries(['display', 'visibility', 'opacity', 'transform', 'color', 'background-color', 'overflow', 'transition-duration', 'animation-name'].map(key => [key, style.getPropertyValue(key)])),
      attributes: Object.fromEntries([...node.attributes].filter(a => /^(aria-|role$|disabled$|tabindex$|data-)/.test(a.name)).map(a => [a.name, a.value])),
    };
  };
  return { url: location.href, theme: document.documentElement.dataset['theme'] ?? null,
    media: { dark: matchMedia('(prefers-color-scheme: dark)').matches, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches },
    viewport: { width: innerWidth, height: innerHeight },
    focus: document.activeElement ? element(document.activeElement) : null,
    elements: Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)].slice(0, 100).map(element)])),
    animations: document.getAnimations().slice(0, 100).map(animation => ({ id: animation.id, state: animation.playState, time: animation.currentTime,
      timing: animation.effect?.getComputedTiming() })),
  };
}
