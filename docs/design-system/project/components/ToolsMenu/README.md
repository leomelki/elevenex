# ToolsMenu

The composer's + menu: attach files (⌘U, or drop or paste them anywhere in the chat), mention a session, task or file (or type @), and turn MCP servers on or off for this session. Each server shows its tool count, or its error in `danger` with the fix.

**Provide:** `servers` (`[{ name, tools, on, error }]`), `open`.

- Do keep server setup out of the composer: Manage MCP servers opens settings; here you only switch them.
- Do show an MCP server error as a `needs you` status on the session when a call fails.
- Don't list more than eight servers; beyond that, add a search field at the top.
