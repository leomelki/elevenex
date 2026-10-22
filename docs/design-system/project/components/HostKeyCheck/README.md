# HostKeyCheck

The server's host key, shown on first contact and pinned. If it ever changes, Elevenex stops and says so (`changed`), in `danger`, with no way through but confirming it.

**Provide:** `host`, `fingerprint`, optional `type` (ED25519 by default), `changed`.

- Do ask once per server, with “Trust and connect” and Cancel under it.
- Don't let a changed key be accepted with one click.
