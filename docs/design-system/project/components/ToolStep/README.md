# ToolStep

One thing the agent did: a command, a read, an edit, a search, a tool call. A light sweep runs across it while it works; it ends in a drawn check (with its time or result) or a `danger` cross. Click to see the output.

**Provide:** `icon` (`terminal` · `file` · `search` · `changes` · `plug`), `verb` (Ran, Read, Edited, Searched…), `detail` (the command or path, mono), `status` (`running` · `done` · `failed`), `meta` (e.g. “6 of 50 failed”, “2.4s”), `output` (text), `open`.

- Use `ToolStep` on its own where a single action stands alone (a side chat, a card). Inside a turn, steps belong to `Turn` / `WorkTimeline`, which group and condense them.
- Do group three or more consecutive reads into one step (“Read 6 files”) that expands.
- Do keep the sweep subtle; it says “alive”, not “look at me”.
