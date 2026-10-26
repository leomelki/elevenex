# HostKeyCheck

The server's host key, shown on first contact and pinned. If it ever changes, Elevenex stops and says so (`changed`), in `danger`, with no way through but confirming it.

**Provide:** `host`, `fingerprint`, optional `type` (ED25519 by default), `changed`.

- Do ask once per server, with “Trust and connect” and Cancel under it.
- A changed key uses a secondary Confirm button, aligned to the right at the standard control height. Use the shared check icon and EaseSwap feedback; keep Trust and connect as the only primary action in the surrounding dialog.
- Keep confirmation visible while connecting, and reset it if the host or fingerprint changes.
