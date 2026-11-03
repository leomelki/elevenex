import { browserAppearance } from './appearance';
import type { BrowserElement } from '@elevenex/shared';
import type { WebContents } from 'electron';

/** Purely decorative page-local overlay. Driver authority never depends on page DOM. */
export class BrowserDecoration {
  private appearance?: ReturnType<typeof browserAppearance>;
  private revision = 0;
  private key: string | null = null;
  private signature = '';
  constructor(private readonly contents: WebContents, private readonly id: string) {}
  async paint(driving: boolean, target: BrowserElement | undefined, dark: boolean, reduced: boolean): Promise<void> {
    const signature = JSON.stringify([driving, target, dark, reduced]);
    if (this.signature === signature || this.contents.isDestroyed()) return;
    this.signature = signature; const revision = ++this.revision;
    const id = 'ex-browser-' + this.id;
    // Only fixed markup, booleans and validated numeric coordinates cross into the page.
    try {
      await this.contents.executeJavaScriptInIsolatedWorld(1002, [{ code: `(() => {
        const old = document.getElementById(${JSON.stringify(id)});
        if (!${driving}) { old?.remove(); return; }
        if (old) return;
        const layer = document.createElement('div'); layer.id = ${JSON.stringify(id)};
        layer.setAttribute('aria-hidden', 'true'); layer.setAttribute('inert', '');
        layer.innerHTML = '<span class="ex-browser-hint">Click anywhere to take over</span><span class="ex-browser-target"></span><span class="ex-browser-cursor"><i class="ex-browser-pulse"></i><svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M3.5 2l9 5.2-4 1.1 2.4 4.3-1.7 1-2.4-4.3-3.3 2.7z" /></svg></span>';
        document.documentElement.appendChild(layer);
      })()` }]);
      const previous = this.key;
      if (!driving) { if (previous) await this.contents.removeInsertedCSS(previous); this.key = null; return; }
      if (revision !== this.revision || this.contents.isDestroyed()) return;
      const appearance = await (this.appearance ??= browserAppearance());
      if (revision !== this.revision || this.contents.isDestroyed()) return;
      const { accent, onAccent, ink, surface } = dark ? appearance.dark : appearance.light;
      const transition = reduced ? 'none' : `transform ${appearance.duration} ${appearance.easing}`;
      const css = `@font-face{font-family:'Elevenex Browser Instrument';src:url(data:font/woff2;base64,${appearance.font}) format('woff2');font-weight:400 700;font-style:normal}#${id}{position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;box-shadow:inset 0 0 0 2px ${accent}!important;font:600 11px/16px 'Elevenex Browser Instrument',system-ui!important}
      #${id}>*{pointer-events:none!important}#${id} .ex-browser-hint{position:absolute!important;top:8px!important;right:8px!important;background:${accent}!important;color:${onAccent}!important;padding:4px 8px!important;border-radius:9999px!important}
      #${id} .ex-browser-target{display:${target ? 'block' : 'none'}!important;position:absolute!important;top:0!important;left:0!important;transform:translate(${target?.x ?? 0}px,${target?.y ?? 0}px)!important;width:${target?.width ?? 0}px!important;height:${target?.height ?? 0}px!important;border-radius:${appearance.radius}!important;box-shadow:0 0 0 2px ${accent},0 0 0 6px ${accent}33!important;transition:${transition}!important}
      #${id} .ex-browser-cursor{display:${target ? 'block' : 'none'}!important;position:absolute!important;top:0!important;left:0!important;transform:translate(${(target?.x ?? 0) + (target?.width ?? 0) * .62}px,${(target?.y ?? 0) + (target?.height ?? 0) * .55}px)!important;color:${surface}!important;filter:drop-shadow(0 1px 1px ${ink})!important;font-size:24px!important;transition:${transition}!important}
      #${id} .ex-browser-pulse{position:absolute!important;top:-8px!important;left:-8px!important;width:24px!important;height:24px!important;border:2px solid ${accent}!important;border-radius:9999px!important;animation:${reduced ? 'none' : `${id}-pulse calc(${appearance.baseDuration} * 8) ${appearance.easeOut} infinite`}!important}
      @keyframes ${id}-pulse{from{transform:scale(.4);opacity:.8}to{transform:scale(1.6);opacity:0}}`;
      const key = await this.contents.insertCSS(css, { cssOrigin: 'user' });
      if (revision !== this.revision) await this.contents.removeInsertedCSS(key); else this.key = key;
      if (previous) await this.contents.removeInsertedCSS(previous);
    } catch { /* Pages may be navigating or crashed; chrome remains authoritative. */ }
  }
  reset(): void { this.signature = ''; }
  destroy(): void { this.revision++; if (this.key && !this.contents.isDestroyed()) void this.contents.removeInsertedCSS(this.key).catch(() => undefined); this.key = null; }
}
