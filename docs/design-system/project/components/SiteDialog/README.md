# SiteDialog

A page in the task's Browser calls `alert()`, `confirm()`, `prompt()` or asks before it unloads. Only you can answer, and the agent never sees the question or your reply. It comes in two parts: a line in the **request bar** above the page, then a small dialog over the window when you choose **Respond**.

## Request bar

One line per pending site request (at most four), on `attention-soft`, stacked with a hairline between them. Each line has a 22px round mark in `attention`, the copy, then a ghost action and a secondary action, in that order.

| Request | It says | Actions |
| --- | --- | --- |
| alert | **shop.example.com** has a message for you | Dismiss · **Respond** |
| confirm | **shop.example.com** asks you to confirm | Dismiss · **Respond** |
| prompt | **shop.example.com** asks you for text | Dismiss · **Respond** |
| leave | **shop.example.com** asks before you leave | Dismiss · **Respond** |
| upload | **shop.example.com** wants files | Cancel · **Choose…** |
| download | `project-export.zip` Ready to save / Downloading… | Cancel · **Save…** (disabled until ready) |

Marks: `chat`, `question`, `pencil`, `back`, `attach`, `download`. The host is bold, and the file name is in `mono-meta`. Lines don't wrap: when there isn't room, the host shortens first (its full name is in the tooltip), then the verb.

## Dialog

**Anatomy:** the `PasskeyAsk` anatomy. A 40px mark on `accent-soft` (`attention-soft` for leave), the title in `title`, the origin in `mono-meta` with `globe`, then the page's message, the field for a prompt, and the buttons on the right (secondary, then the one primary). 420px wide on `surface-raised`, `radius-lg`, `shadow-pop`; it fits narrow windows and lets long hosts wrap.

| Type | Title | Body | Actions | Focus |
| --- | --- | --- | --- | --- |
| alert | "shop.example.com says" | the message | **OK** | OK |
| confirm | "shop.example.com says" | the message | Cancel · **OK** | OK |
| prompt | "shop.example.com says" | the message, then one field with the page's default, selected | Cancel · **OK** (↵ in the field) | the field |
| leave | "Leave this site?" | "Changes you made may not be saved." | Stay · **Leave** | Stay |

- **Say who's asking; quote what they say.** The title and origin are Elevenex's words and come from the tab's URL: the host as the URL parser writes it, so internationalized names stay in punycode, and the full origin with scheme and port under it. The page's message sits under a quiet left rule, in its own text with line breaks kept, never as markup. Without an http(s) origin (`about:`, `data:`) the title reads "This page says" and the origin line goes away. An empty message leaves no empty rule.
- **A leave prompt uses our words only.** Like other browsers, it never shows the page's text, so a page can't make up a reason to stay. Its safe answer, Stay, has focus.
- **Esc and the dim cancel.** For an alert that simply closes it; otherwise it answers Cancel or Stay. `ModalLayer` traps focus while it's open and restores it on close.
- **The answer belongs to its tab.** Switching tabs or the page navigating closes the dialog without answering; the draft is never sent to another tab. A prompt's text stays local until OK.
- **Motion:** the `ModalLayer` pop: in over `dur-slow` on `ease-out`, out over `dur-base` on `ease-in`, with the dim fading on its own. The field's ring eases in over `dur-fast`. Reduced motion: it appears and leaves at once.

**Provide:** the tab's `pageUrl` and its pending `requests` (`TaskBrowserWorkflow`). It answers with `dialog-response` (`accept`, `text`), `choose-files`, `save-download` or `cancel-workflow` for that tab.

- Do use it for every JavaScript dialog from the task Browser.
- Don't show it to the agent or put any of it in the chat.
- Don't use it for passkeys or security keys: those get `PasskeyAsk`.

In the app it's `ex-browser-site-requests` (`apps/renderer/src/app/task-browser/browser-site-requests.component.*`), mounted by the task browser above the page.
