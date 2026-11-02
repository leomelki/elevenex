# Message

A message in the chat. Yours is a bubble on the right (its tail at the bottom right); its time appears under it on hover; it's always shown in full (when a long reply pushes it out of view, `ChatScroll` pins it at the top). Agent replies with work are `Turn`; `Message` with `role: 'agent'` is for short replies without tool use (side chats): the same gutter and mark as a turn, the text, and a footer with side chat · fork · copy on hover or focus.

**Provide:** `role` (`user` · `agent`), children (paragraphs, inline `code`), `time` (yours: under the bubble on hover; the agent's: in the mark's tooltip), `isNew`, `id` (yours: lets `ChatScroll` pin it), for agents `author`, `mark`, `sideChats` (count), `pinned` (keep actions visible).

- Do write agent replies as prose with code inline; no headings in short replies.
- Do branch from a message, not from the chat: side chats and forks remember the exact turn.
- Keys, with a message focused (↑ from an empty composer focuses the last one): S side chat, F fork from here, C copy.
- **Sending** (`isNew`, with `Composer`'s `onSend`): your words lift out of the input and travel to their place, becoming the bubble on the way. Its fill and shadow arrive as it settles, in 380ms on `ease-glide`. The text you typed is the text that lands; nothing disappears.
  - Meanwhile the conversation slides up by the new bubble's height (340ms, `ease-out`) instead of jumping, and your own message always comes into view.
  - With no fresh send to fly from (another window, a queued message that sends later), or a message taller than about six lines, it rises 14px into place instead.
  - With reduced motion, it fades in (160ms).
- Streamed text un-blurs in through `StreamText`.
- Don't put avatars or names on your own messages.
