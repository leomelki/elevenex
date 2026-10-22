# SideThread

A side chat: a short thread branched from one message to ask a follow-up without adding to the main session's context. It opens as a popover beside the message; Promote turns it into a fork with the full history.

**Provide:** `anchor` (the quoted excerpt it branched from), `title`, children (messages), optional `className`.

- Do quote the anchor so the side chat stands on its own.
- Do keep the “not added to the main session’s context” note visible; it is the feature.
- Don't let side chats edit files; promote them to a fork first.
