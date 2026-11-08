# BrowserView

The Browser side view: a real browser that belongs to the task, shared by the agent and you. It has several tabs; the agent opens and drives some, you use others. Each tab has **one driver at a time**: the agent or you, never both, and the driver is always shown.

**Provide:**
- `tabs`: `[{ id, title, url, server, by, color }]`. `by` is `'agent'` for tabs the agent opened; they carry its mark. `server` names the task's dev server serving the tab (web, api, storybook) and shows as a chip in the address bar.
- `active`, `onSelect`, `onClose`, `onNew`.
- `driver`: `'agent'` | `'you'` | `'needs'`, with `onTakeOver` and `onHandBack`.
- `step`: `{ n, total, text }`, what the agent is doing now.
- `action`: `{ x, y, w, h, label }`, the element it acts on, in page coordinates.
- `agentWaiting`: you took over in the middle of the agent's work.
- `picking`, `onPick(on)`, `hovered` and `picked` (`{ x, y, w, h, label, file }`), `onAsk(text)`, `askLabel`, `askNote`.
- `errors`, `errorText`, `onSendErrors`.
- `width` (`'full'` | `'phone'`), `onWidth`.
- `needsTitle`, `needsText`.
- Children: the page itself (in the app, the webview).

**While the agent drives**
- Its tab's mark breathes. The pill in the address bar says **Driving**, and the view gets a thin accent frame with "Click anywhere to take over".
- A ring and a label show the element it's acting on ("Typing a test card"), and its cursor **glides** to each new target (`dur-slow`, `ease-in-out`), with a soft pulse where it clicks. It never jumps.
- The bar under the page says what it's doing: **Step 5 of 9 · Filling the card with a test number**, with a dot per step. The text crossfades from step to step. **Take over** is there too.
- **Your click or keystroke in the page takes over at once.** The agent stops and waits, and the bar says "You're driving; the agent waits" with **Hand back**.

**When it needs you** (a sign-in, a 2FA code, a payment form):
- The agent stops and the pill says **Your turn**.
- A banner opens above the page ("The agent needs you to sign in"), with **I'm done**.
- Password, card and code fields are masked in everything the agent reads. It never sees what you type there.
- A passkey or security-key request opens `PasskeyAsk`, a sheet over the window (never inside the page), which asks, waits for the key and explains a failure.
- A page's `alert`, `confirm`, `prompt` or leave prompt, and its uploads and downloads, wait in a request bar above the page; **Respond** opens `SiteDialog`, which names the asking site, quotes its message and answers only for that tab.

**Point and ask** (⇧⌘C, or the target button). Three moments, all in `review` indigo so your selection never reads as the agent's teal:
- **Point.** The page gets a thin indigo frame and one pill at its top: "Click an element to ask about it · Esc". The agent's frame, cursor and ring step aside. Where the page can be inspected on hover, the element under the pointer gets a light ring and a chip with its selector and source line ("button.pay · CheckoutForm.tsx:88", through source maps). That ring **snaps** to the pointer; a ring gliding behind a pointer only lags. Clicks never reach the page. Esc, the target button or ⇧⌘C again cancels.
- **Pick.** The ring locks in: it turns solid, and one ring goes out from the element, once.
- **Ask.** A small card comes out of the element: under it, or over it when it sits low; on a narrow page (under 400px) or when the element is out of view, docked across the page at the edge away from it. It never covers what you picked. It holds the element's name and source line, a draft that grows to six lines, one quiet line on what it sends (`askNote`), and the send button with ↵. ↵ sends (⇧↵ for a new line), Esc or × dismisses and focus goes back where it was (the target button, when the pick left it in the page), and the target in the card picks another element and keeps the draft.
- In the app, the page pauses while you write (it never takes input then): the card and ring sit over a quiet dotted ground with "Page paused while you ask".

**Errors:** console errors and failed requests show in the bar under the page ("2 errors · POST /charges 504 after 8s") with **Send to agent**. While the agent is working on this page, it gets them as they happen.

**Tools in the bar:**
- Back, Reload, the address (with the server chip).
- The driver pill, Point and ask, Phone width (390px, easing).
- ⋯: a screenshot to the chat, light or dark, slow network, open outside.

**Motion:** tabs grow in and close away (never pop). The pill's label crossfades as its width eases (`EaseSwap`), and the banner and the bars open and close with `Fold`. Point and ask: the frame fades in, the pill drops 8px on the glide spring, the card grows from the picked element (from 0.96 and 4px towards it, `dur-base` `ease-out`; it never bounces) and leaves quicker on `ease-in`; a growing draft keeps the card's edge by the element still. Under reduced motion, everything applies at once.

- Do keep everything in the task: tabs open in its workspace's servers and come back when you reopen the task.
- Do let the agent open tabs freely (docs, the app). It drives only the ones it opened, unless you hand one over.
- Don't let the agent type in a tab you're using, or into a password, card or code field.
