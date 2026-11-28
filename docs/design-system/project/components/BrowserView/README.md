# BrowserView

The Browser side view: a real browser that belongs to the task, shared by the agent and you. It has several tabs; the agent opens and drives some, you use others. The activity indicator shows when the agent is working; ordinary interaction needs no human/agent mode switch.

**Provide:**
- `tabs`: `[{ id, title, url, server, by, color }]`. `by` is `'agent'` for tabs the agent opened; they carry its mark. `server` names the task's dev server serving the tab (web, api, storybook) and shows as a chip in the address bar.
- `active`, `onSelect`, `onClose`, `onNew`.
- `driver`: `'agent'` | `'you'` | `'needs'`, with `onTakeOver` and `onHandBack`.
- `step`: `{ n, total, text, status? }`, what the agent is doing now. The Angular
  implementation accepts running, waiting, done or error and reuses status glyphs.
- `cursor`: optional `{ x, y, pulse }`, an independent viewport-CSS cursor. A new
  pulse identity produces one ripple; movement retargets the current glide.
- `action`: `{ x, y, w, h, label }`, the element it acts on, in page coordinates.
- `agentWaiting`: the user explicitly blocked the agent.
- `picking`, `onPick(on)`, `hovered` and `picked` (`{ x, y, w, h, label, file }`), `onAsk(text)`, `askLabel`, `askNote`.
- `errors`, `errorText`, `onSendErrors`.
- `width` (`'full'` | `'phone'`), `onWidth`.
- `needsTitle`, `needsText`.
- Children: the page itself (in the app, the webview).

**While the agent drives**
- Its tab's mark breathes. The pill in the address bar says **Working**, and the view gets a thin accent frame with "You can interact anytime".
- A ring and a label show the element it's acting on ("Typing a test card"), and its cursor **glides** to each new target (`dur-slow`, `ease-in-out`), with a soft pulse where it clicks. It never jumps.
  The agent pointer is a teal faceted arrow with a small sparkle and a contrasting
  surface outline. The arrow tip and click pulse share the exact page coordinate.
- The bar under the page says what it's doing: **Step 5 of 9 · Filling the card with a test number**, with bounded step dots and current status. The text crossfades from step to step. **Block agent** is always available, including without step metadata, and becomes **Allow agent** when blocked.
- **Your click or keystroke interrupts current work at once.** The agent can acquire a fresh page immediately without asking for a handoff. Only **Block agent** persistently stops access; the bar then says "Agent blocked" with **Allow agent**.

**When it needs you** (a sign-in, a 2FA code, a payment form):
- The agent stops and the pill says **Action needed**.
- A banner opens above the page ("The agent needs you to sign in"), with **I'm done**.
- Password, card and code fields are masked in everything the agent reads. It never sees what you type there.
- A passkey or security-key request opens `PasskeyAsk`, a sheet over the window (never inside the page), which asks, waits for the key and explains a failure.
- A page's `alert`, `confirm`, `prompt` or leave prompt, and its uploads and downloads, wait in a request bar above the page; **Respond** opens `SiteDialog`, which names the asking site, quotes its message and answers only for that tab.

**Point and ask** (⇧⌘C, or the target button). Three moments, all in `review` indigo so your selection never reads as the agent's teal:
- **Point.** The page gets a thin indigo frame and one pill at its top: "Click an element to ask about it · Esc". The agent's frame, cursor and ring step aside. Where the page can be inspected on hover, the element under the pointer gets a light ring and a chip with its selector and source line ("button.pay · CheckoutForm.tsx:88", through source maps). That ring **snaps** to the pointer; a ring gliding behind a pointer only lags. Clicks never reach the page. Esc, the target button or ⇧⌘C again cancels.
- **Pick.** The ring locks in: it turns solid, and one ring goes out from the element, once.
- **Ask.** A small card comes out of the element: under it, or over it when it sits low; on a narrow page (under 400px) or when the element is out of view, docked across the page at the edge away from it. It never covers what you picked. It holds the element's name and source line, a draft that grows to six lines, one quiet line on what it sends (`askNote`), and the send button with ↵. ↵ sends (⇧↵ for a new line), Esc or × dismisses and focus goes back where it was (the target button, when the pick left it in the page), and the target in the card picks another element and keeps the draft.

Source locations are optional platform data. The task browser resolves framework
development metadata or explicit compiler markers on human picks and shows it in
the card. `askNote` distinguishes an element
location, a DOM ancestor location, a component declaration/file with unavailable
element line, and the selector-only fallback. Missing coordinates are omitted.
A reported location never authorizes
filesystem access, and unavailable metadata must not block asking. See the
[source resolver contract](../../../../../packages/browser-inspection/README.md).
- In the app, the page pauses while you write (it never takes input then): the card and ring sit over a quiet dotted ground with "Page paused while you ask".

**Errors:** console errors and failed requests show in the bar under the page ("2 errors · POST /charges 504 after 8s") with **Send to agent**. While the agent is working on this page, it gets them as they happen.

**Tools in the bar:**
- Back, Reload, the address (with the server chip).
- The driver pill, Point and ask, Phone width (390px, easing).
- ⋯: a screenshot to the chat, light or dark, slow network, open outside.

**Motion:** tabs grow in and close away (never pop). The pill's label crossfades as its width eases (`EaseSwap`), and the banner and the bars open and close with `Fold`. Point and ask: the frame fades in, the pill drops 8px on the glide spring, the card grows from the picked element (from 0.96 and 4px towards it, `dur-base` `ease-out`; it never bounces) and leaves quicker on `ease-in`; a growing draft keeps the card's edge by the element still. Under reduced motion, everything applies at once.

- Do keep everything in the task: tabs open in its workspace's servers and come back when you reopen the task.
- Do let the agent open tabs freely (docs, the app) and acquire available task tabs without a handoff.
- Do preserve explicit agent blocks until the person allows access. Agent reacquisition cancels pending help tickets without claiming completion; native site dialogs and authentication retain their normal resolution.

The desktop task browser uses `pickMode = "pin"` (Angular): the pointing pill reads "Click an element to point at it in your message", the picked ring locks in, and no question card grows; the owner stages the element in the chat as an [ElementPin](../ElementPin/README.md). The default `ask` mode keeps the card below.
