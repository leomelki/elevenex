# PasskeyAsk

A site in the task's Browser asks for a passkey or a security key, and only you can answer. It's one small sheet over the window (a native sheet on macOS, a small modal window elsewhere) that carries the whole exchange: ask, wait for the key, pick an account, say what went wrong. Nothing else asks: no system alert before it, no bare window after it.

| Phase | It says | Actions |
| --- | --- | --- |
| `confirm` | "Sign in to github.com" (or "Create a passkey for github.com"), the exact origin under it, what the page wants, and one quiet line: the device does the signing, the key never leaves it, agents can't use it | Cancel · **Continue** |
| `waiting` | "Touch your security key": insert it, touch it when it blinks. On Windows, "Follow your device's prompt": Windows Hello takes over. The key mark breathes; the footer says "Waiting for your key…" with the spinning ring | Cancel |
| `accounts` | "Choose an account": the key holds more than one passkey for the site. One row per account: initial, name, and the username under it when it differs | each row · Cancel |
| `failed` | "Couldn't sign in to github.com", and why, in one line: it timed out or was canceled, this key already holds a passkey for the site, the site isn't allowed to use it, or the device can't do it. A timeout adds "Keys that ask for a PIN can't be used here yet." | Close · **Try again** |

**Anatomy:** a 40px key mark on `accent-soft` (`attention-soft` when failed), the title in `title`, the origin in `mono-meta` with the `globe` icon, the detail in `body`, an optional note on `surface-sunken` with the `lock` icon, then the footer: the live status on the left, the buttons on the right (secondary, then the one primary). 420px wide on `surface-raised`; the height fits each phase.

**Provide:** `phase`, `origin`, `operation` (`'get'` sign in · `'create'` a new passkey), `accounts` (`[{ displayName, name }]`, at most 32) for `accounts`, the error `name` for `failed`, and the platform (Windows reads differently). It answers with one choice: `continue`, `retry`, `account:<n>` or `cancel`.

- **Say who's asking, exactly.** The title names the host; under it, the full origin with scheme and port. Internationalized names stay in punycode (`xn--pple-43d.com`), so a lookalike can't borrow another site's letters.
- **Ask once, then get out of the way.** Nothing touches the key before Continue. After it, the same sheet waits, picks and fails in place; a success simply closes it.
- **Stray input can't approve.** Continue, an account and Try again ignore clicks and keys for 500ms after the sheet appears or comes back into focus, so an Enter meant for the page underneath doesn't answer it. Cancel, Esc and closing the window always work.
- **Failing is not a dead end.** The site keeps waiting while you read why; Try again reruns the same request you approved. It stops on its own after two minutes, as the site's request does.
- **Focus where the answer is:** Continue on `confirm`, Cancel while `waiting`, the first account (↑↓ to move, ↵ to pick), Try again on `failed`. Each change is announced politely.
- **Motion:** the height eases with the window (natively on macOS); the new phase's text settles from −4px in `dur-base` on `ease-out`; the mark's ring breathes only while waiting. Reduced motion: no settling, a still ring, a still status ring.

- Do use it for every WebAuthn request from the Browser, registration and sign-in alike.
- Don't put it in the page or in the chat: it belongs to the window, above anything a site can draw.
- Don't show the agent anything: options, keys and results never reach the session.

In the app it's a document owned by the desktop process (`apps/desktop/src/browser/webauthn-prompt-*.ts`), not an Angular component: it runs at the site's origin in an isolated session, with no script of its own, styled from `tokens.css` and Instrument Sans.
