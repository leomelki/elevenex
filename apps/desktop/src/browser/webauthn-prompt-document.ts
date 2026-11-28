import type { PromptView } from './webauthn-prompt-view';

/** Design inputs for the sheet. Both are optional at runtime so a missing build
 * asset degrades the look, never the ability to authenticate. */
export interface PromptAssets {
  /** `docs/design-system/project/tokens.css`, staged next to this module. */
  readonly tokens: string;
  /** Instrument Sans (WOFF2, base64) from the renderer's bundled fonts. */
  readonly font?: string;
}

export const PROMPT_WIDTH = 420;
/** Ignore choices that proceed (Continue, an account, Try again) for this long
 * after the sheet appears or regains focus, so a click or Enter aimed at the
 * page underneath cannot approve a request that just opened. */
export const PROMPT_INPUT_GUARD_MS = 500;

// Paths from the renderer's ICON_PATHS (`key`, `globe`, `lock`). The desktop
// process cannot import renderer code; keep these in step with that set.
const KEY = 'M10 2.5a3.5 3.5 0 1 1-2.9 5.46L3 12v1.5H1.5V12l4.4-4.4A3.5 3.5 0 0 1 10 2.5zM10.5 5.2h.01';
const GLOBE = 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM2.5 8h11M8 2.5c1.6 1.5 2.4 3.4 2.4 5.5S9.6 12 8 13.5C6.4 12 5.6 10.1 5.6 8S6.4 4 8 2.5z';
const LOCK = 'M4.5 7h7a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM5.5 7V5a2.5 2.5 0 0 1 5 0v2';
const icon = (path: string, size: number) =>
  `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;

const STYLE = `
*{box-sizing:border-box}
html{background:var(--surface-raised)}
body{margin:0;color:var(--ink);font-family:var(--font-sans);font-size:var(--text-ui-size);line-height:var(--text-ui-line);-webkit-font-smoothing:antialiased;overflow:hidden;user-select:none;cursor:default}
#sheet{display:flex;flex-direction:column;gap:var(--space-4);padding:var(--space-6) var(--space-6) var(--space-4)}
header{display:flex;align-items:center;gap:var(--space-3);min-width:0}
.mark{position:relative;flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:var(--radius-md);background:var(--accent-soft);color:var(--accent)}
.mark svg{width:20px;height:20px}
.mark::after{content:"";position:absolute;inset:-4px;border-radius:calc(var(--radius-md) + 4px);border:2px solid var(--accent);opacity:0;pointer-events:none}
[data-phase=waiting] .mark::after{animation:breathe 1.6s var(--ease-in-out) infinite}
[data-phase=failed] .mark{background:var(--attention-soft);color:var(--attention)}
[data-phase=failed] .mark::after{display:none}
.heading{display:flex;flex-direction:column;gap:2px;min-width:0}
h1{margin:0;font-size:var(--text-title-size);line-height:var(--text-title-line);font-weight:var(--text-title-weight);letter-spacing:var(--text-title-tracking);overflow-wrap:anywhere}
.origin{display:flex;align-items:center;gap:var(--space-1);margin:0;min-width:0;color:var(--ink-muted);font-family:var(--font-mono);font-size:var(--text-mono-meta-size);line-height:var(--text-mono-meta-line);font-weight:var(--text-mono-meta-weight);user-select:text;cursor:text}
.origin svg{flex:none}
.origin span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
p{margin:0}
.detail{font-size:var(--text-body-size);line-height:var(--text-body-line);overflow-wrap:anywhere}
.note{display:flex;gap:var(--space-2);align-items:flex-start;padding:var(--space-2) var(--space-3);border-radius:var(--radius-sm);background:var(--surface-sunken);color:var(--ink-muted);font-size:var(--text-caption-size);line-height:var(--text-caption-line)}
.note svg{flex:none;margin-top:1px}
.accounts{display:flex;flex-direction:column;gap:2px;margin:0;padding:var(--space-1);max-height:212px;overflow:auto;list-style:none;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--surface)}
.account{display:flex;align-items:center;gap:var(--space-3);width:100%;min-height:44px;padding:var(--space-1) var(--space-2);border:0;border-radius:var(--radius-sm);background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer;transition:background-color var(--dur-fast)}
.account:hover{background:var(--surface-sunken)}
.account:focus-visible{outline:none;box-shadow:var(--focus-ring)}
.avatar{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:var(--radius-full);background:var(--accent-soft);color:var(--accent);font-weight:600}
.names{display:flex;flex-direction:column;min-width:0}
.names span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.user{color:var(--ink-muted);font-size:var(--text-caption-size);line-height:var(--text-caption-line);font-weight:400}
footer{display:flex;align-items:center;justify-content:flex-end;gap:var(--space-2);min-height:var(--control-height);margin-top:var(--space-2)}
.status{display:flex;align-items:center;gap:var(--space-2);margin-right:auto;min-width:0;color:var(--ink-muted);font-size:var(--text-caption-size);line-height:var(--text-caption-line)}
.spinner{flex:none;width:12px;height:12px;border-radius:var(--radius-full);border:1.5px solid color-mix(in oklab,var(--accent) 25%,transparent);border-top-color:var(--accent);animation:spin .9s linear infinite}
button.action{height:var(--control-height);padding:0 var(--space-3);border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface-raised);color:var(--ink);font:inherit;font-weight:var(--text-ui-weight);white-space:nowrap;cursor:pointer;transition:background-color var(--dur-fast),transform var(--dur-glide) var(--ease-spring)}
button.action:hover{background:var(--surface-sunken)}
button.action.primary{border-color:transparent;background:var(--accent);color:var(--on-accent)}
button.action.primary:hover{background:color-mix(in oklab,var(--accent) 88%,var(--ink))}
button.action:active{transform:scale(.97);transition-duration:var(--dur-instant)}
button.action:focus-visible{outline:none;box-shadow:var(--focus-ring)}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
[hidden]{display:none!important}
.entering>:not(footer){animation:content-in var(--dur-base) var(--ease-out) both}
@keyframes content-in{from{opacity:0;transform:translateY(-4px)}}
@keyframes breathe{0%,100%{opacity:0;transform:scale(.94)}50%{opacity:.85;transform:scale(1)}}
@keyframes spin{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){
  .entering>:not(footer){animation:none}
  [data-phase=waiting] .mark::after{animation:none;opacity:.6}
  .spinner{animation:none;border-color:var(--accent)}
  button.action,.account{transition:none}
}`;

/** One fixed, inert document. Every phase's text is written later by the
 * controller; nothing in this markup depends on the request. */
export function promptDocument(assets: PromptAssets, nonce: string): { readonly html: string; readonly policy: string } {
  const font = assets.font
    ? `@font-face{font-family:"Instrument Sans";src:url(data:font/woff2;base64,${assets.font}) format("woff2");font-weight:400 700;font-style:normal;font-display:block}`
    : '';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">'
    + '<title>Sign in with a passkey</title>'
    + `<style nonce="${nonce}">${font}${assets.tokens}${STYLE}</style></head><body>`
    + '<div id="sheet" role="dialog" aria-modal="true" data-phase="confirm" aria-labelledby="title" aria-describedby="detail">'
    + `<header><span class="mark">${icon(KEY, 20)}</span><div class="heading"><h1 id="title"></h1>`
    + `<p class="origin">${icon(GLOBE, 12)}<span id="origin"></span></p></div></header>`
    + '<p class="detail" id="detail"></p>'
    + `<p class="note" id="note" hidden>${icon(LOCK, 12)}<span id="note-text"></span></p>`
    + '<ul class="accounts" id="accounts" aria-labelledby="title" hidden></ul>'
    + '<footer><p class="status" id="status" hidden><span class="spinner" aria-hidden="true"></span><span id="status-text"></span></p>'
    + '<button class="action" id="secondary" type="button" data-choice="cancel"></button>'
    + '<button class="action primary" id="primary" type="button" hidden></button></footer>'
    + '<p class="visually-hidden" id="announce" role="status" aria-live="polite"></p>'
    + '</div></body></html>';
  // No script runs in this document: main injects the fixed controller below.
  // Fonts are inline data, so the session still serves exactly one URL.
  const policy = `default-src 'none'; script-src 'none'; style-src 'nonce-${nonce}'; font-src data:; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
  return { html, policy };
}

/** A design-token color for the window's native background, so the sheet does
 * not flash a different color before its first paint. */
export function promptBackground(tokens: string, dark: boolean): string {
  const block = dark ? tokens.match(/\[data-theme="dark"\]\s*\{([^}]+)/)?.[1] : tokens.match(/:root,\s*\[data-theme="light"\]\s*\{([^}]+)/)?.[1];
  return block?.match(/--surface-raised:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? (dark ? '#171d25' : '#ffffff');
}

/** Runs in the ceremony document's main world, which has no other script.
 * It is serialized with `toString()`, so it must stay self-contained. */
function promptController(guardMs: number): void {
  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error('Prompt element missing: ' + id);
    return found;
  };
  const sheet = element('sheet'), primary = element('primary'), secondary = element('secondary'), accounts = element('accounts');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const pending: Array<(choice: string) => void> = [];
  let armedAt = performance.now();
  let rendered = false;
  const settle = (choice: string) => {
    if (choice !== 'cancel' && performance.now() - armedAt < guardMs) return;
    for (const resolve of pending.splice(0)) resolve(choice);
  };
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('[data-choice]') : null;
    if (target instanceof HTMLElement && target.dataset['choice']) settle(target.dataset['choice']);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); settle('cancel'); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...accounts.querySelectorAll<HTMLElement>('button')];
    const index = rows.findIndex(row => row === document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
  addEventListener('focus', () => { armedAt = performance.now(); });
  const write = (id: string, text: string) => { element(id).textContent = text; };
  const api = {
    render(view: PromptView): number {
      sheet.dataset['phase'] = view.phase;
      write('title', view.title);
      write('origin', view.origin);
      write('detail', view.detail);
      write('note-text', view.note);
      element('note').hidden = !view.note;
      write('status-text', view.status);
      element('status').hidden = !view.status;
      secondary.textContent = view.secondary;
      primary.hidden = !view.primary;
      primary.textContent = view.primary?.label ?? '';
      primary.dataset['choice'] = view.primary?.choice ?? '';
      accounts.replaceChildren(...view.accounts.map((account, index) => {
        const item = document.createElement('li');
        const row = document.createElement('button');
        row.type = 'button'; row.className = 'account'; row.dataset['choice'] = 'account:' + index;
        const avatar = document.createElement('span');
        avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = account.initial;
        const names = document.createElement('span');
        names.className = 'names';
        const name = document.createElement('span');
        name.textContent = account.name;
        names.append(name);
        if (account.detail) {
          const user = document.createElement('span');
          user.className = 'user'; user.textContent = account.detail;
          names.append(user);
        }
        row.append(avatar, names);
        item.append(row);
        return item;
      }));
      accounts.hidden = view.accounts.length === 0;
      if (rendered) {
        element('announce').textContent = view.announce;
        if (!reduceMotion.matches) { sheet.classList.remove('entering'); void sheet.offsetWidth; sheet.classList.add('entering'); }
      }
      rendered = true;
      armedAt = performance.now();
      const focus = view.phase === 'accounts' ? accounts.querySelector<HTMLElement>('button') : view.primary ? primary : secondary;
      focus?.focus();
      return Math.ceil(sheet.getBoundingClientRect().height);
    },
    choice(): Promise<string> { return new Promise(resolve => { pending.push(resolve); }); },
  };
  Object.defineProperty(window, 'elevenexPrompt', { value: api });
}

export const controllerProgram = (): string => `(${promptController.toString()})(${PROMPT_INPUT_GUARD_MS}); undefined`;
/** The view is data: JSON is a valid JavaScript expression and is written with textContent. */
export const renderProgram = (view: PromptView): string => `window.elevenexPrompt.render(${JSON.stringify(view)})`;
export const choiceProgram = (): string => 'window.elevenexPrompt.choice()';
