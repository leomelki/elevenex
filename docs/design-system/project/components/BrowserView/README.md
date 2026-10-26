# BrowserView

The Browser side view: a real browser that belongs to the task, shared by the agent and you. It has several tabs; the agent opens and drives some, you use others. Each tab has **one driver at a time**: the agent or you, never both, and the driver is always shown.

**Provide:**
- `tabs`: `[{ id, title, url, server, by, color }]`. `by` is `'agent'` for tabs the agent opened; they carry its mark. `server` names the task's dev server serving the tab (web, api, storybook) and shows as a chip in the address bar.
- `active`, `onSelect`, `onClose`, `onNew`.
- `driver`: `'agent'` | `'you'` | `'needs'`, with `onTakeOver` and `onHandBack`.
- `step`: `{ n, total, text }`, what the agent is doing now.
- `action`: `{ x, y, w, h, label }`, the element it acts on, in page coordinates.
- `agentWaiting`: you took over in the middle of the agent's work.
- `picking`, `onPick`, `picked` (`{ x, y, w, h, label, file }`), `onAsk(text)`.
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

**Point and ask** (⇧⌘C, or the target button):
- Pick any element on the page. It gets a ring and its selector with the source file and line ("button.pay · CheckoutForm.tsx:88", through source maps).
- A small box asks what should change. ↵ sends it to the session with a screenshot of the element.

**Errors:** console errors and failed requests show in the bar under the page ("2 errors · POST /charges 504 after 8s") with **Send to agent**. While the agent is working on this page, it gets them as they happen.

**Tools in the bar:**
- Back, Reload, the address (with the server chip).
- The driver pill, Point and ask, Phone width (390px, easing).
- ⋯: a screenshot to the chat, light or dark, slow network, open outside.

**Motion:** tabs grow in and close away (never pop). The pill's label crossfades as its width eases (`EaseSwap`), and the banner and the bars open and close with `Fold`. Under reduced motion, everything applies at once.

- Do keep everything in the task: tabs open in its workspace's servers and come back when you reopen the task.
- Do let the agent open tabs freely (docs, the app). It drives only the ones it opened, unless you hand one over.
- Don't let the agent type in a tab you're using, or into a password, card or code field.
