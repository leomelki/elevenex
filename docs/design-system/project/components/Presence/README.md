# Presence

Keeps an element on screen while it leaves. When `show` turns false, the child gets `.is-leaving` (fade, 4px drop, 0.98 scale on `ease-in`, about two thirds of its entry time), stops taking input, and is removed after `exit` ms. Use it for popovers, toasts, queued messages (steering plays a lift-off instead) and anything else that should not just vanish. The pickers' menus (agent, permissions, tools, workspace) use the hook form, `usePresence(open, exit)`, which returns `{ m, l }` (mounted, leaving).

**Provide:** `show`, `exit` (ms, default 160), the element as children.

- Do keep exits shorter than entries; leaving should never hold up the next thing.
- Don't wrap list rows in it; lists that change while you watch are a `MotionList`.
